// routes/chat.js
//
// Express router that powers the SmartCart Access chat UI.
// Drop this into your existing Node.js server as a separate route
// from your `/mcp` route, e.g. in server.js:
//
//   const chatRouter = require('./routes/chat');
//   app.use(express.json());
//   app.use('/api', chatRouter);
//   app.use(express.static('public')); // serves public/index.html
//
// It does three things:
//   1. Takes the user's chat message + history from the frontend.
//   2. Sends it to an LLM on Amazon Bedrock (default: Anthropic Claude)
//      with a system prompt describing the agent's role, plus tool
//      definitions for verify_delivery / unlock_door.
//   3. When the model asks to use a tool, this route calls out to your
//      local MCP server to actually perform the action, feeds the
//      result back to the model, and loops until the model returns a
//      final text answer — which is sent back to the frontend along
//      with a trace of every tool call made.

const express = require('express');
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const router = express.Router();

// ---------------------------------------------------------------------------
// Config — fill these in (env vars recommended)
// ---------------------------------------------------------------------------
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Any Bedrock model that supports the Converse API + tool use.
// Anthropic Claude example model IDs on Bedrock:
//   'anthropic.claude-3-5-sonnet-20241022-v2:0'
//   'anthropic.claude-3-haiku-20240307-v1:0'
// Amazon Titan Text models do not currently support tool use via
// Converse, so keep this on a Claude model if you're using the tools below.
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0';

// Where your local MCP server (the one handling the `/mcp` route) is
// listening. The chat backend calls into it to actually verify
// deliveries and unlock the door.
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

const client = new BedrockRuntimeClient({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  {
    text:
      'You are the SmartCart Access Alexa+ Agent. You manage delivery access. ' +
      'You have access to tools on a local MCP server to verify deliveries and unlock doors. ' +
      'Always verify a delivery with the verify_delivery tool before unlocking the door. ' +
      'Never call unlock_door unless verify_delivery has just confirmed the delivery is scheduled and legitimate. ' +
      'If verification fails, explain why and do not unlock the door. ' +
      'Keep responses short, clear, and appropriate for a voice assistant to speak aloud.',
  },
];

// ---------------------------------------------------------------------------
// Tool definitions the model can call. These map 1:1 to tools your MCP
// server exposes over `/mcp`. Adjust names/schemas to match your actual
// MCP tool definitions.
// ---------------------------------------------------------------------------
const TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'verify_delivery',
        description:
          "Checks a delivery driver's ID against the day's scheduled deliveries via Ring event data and the delivery schedule.",
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              driverId: {
                type: 'string',
                description: 'The delivery driver ID reported at the door, e.g. DRV-8829',
              },
              ringEventId: {
                type: 'string',
                description: 'Optional Ring doorbell/motion event ID associated with this arrival',
              },
            },
            required: ['driverId'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'unlock_door',
        description:
          'Issues a command to the Ring smart lock to grant temporary access for a verified delivery, and schedules the lock to re-secure automatically.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              driverId: {
                type: 'string',
                description: 'The verified delivery driver ID being granted access',
              },
              durationSeconds: {
                type: 'number',
                description: 'How long to keep the door unlocked before auto-relocking, default 120',
              },
            },
            required: ['driverId'],
          },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Bridge: call the local MCP server's tool with the given name/input.
// Adjust the request shape to match however your `/mcp` route expects
// JSON-RPC / Streamable HTTP tool calls.
// ---------------------------------------------------------------------------
async function callMcpTool(name, input) {
  const res = await fetch(MCP_SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: input },
    }),
  });

  if (!res.ok) {
    throw new Error(`MCP server returned ${res.status} for tool "${name}"`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`MCP tool "${name}" error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // Adjust this extraction to match your MCP server's response shape.
  return data.result ?? data;
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
router.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing "message" string in request body.' });
    }

    // `history` is the running Bedrock Converse message list from the
    // frontend, so the model keeps context across turns.
    let messages = Array.isArray(history) ? [...history] : [];
    messages.push({ role: 'user', content: [{ text: message }] });

    const toolTrace = [];
    let finalReply = null;

    // Tool-use loop: keep calling the model until it stops asking for tools.
    for (let turn = 0; turn < 6 && finalReply === null; turn++) {
      const command = new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM_PROMPT,
        messages,
        toolConfig: TOOL_CONFIG,
        inferenceConfig: { maxTokens: 512, temperature: 0.3 },
      });

      const response = await client.send(command);
      const outputMessage = response.output.message;
      messages.push(outputMessage);

      const toolUseBlocks = outputMessage.content.filter((block) => block.toolUse);

      if (toolUseBlocks.length === 0) {
        // No tool calls — this is the model's final answer.
        const textBlock = outputMessage.content.find((block) => block.text);
        finalReply = textBlock ? textBlock.text : '(no response)';
        break;
      }

      // Execute each requested tool call against the MCP server, then
      // feed the results back to the model as toolResult blocks.
      const toolResultContent = [];

      for (const block of toolUseBlocks) {
        const { toolUseId, name, input } = block.toolUse;
        let result;
        let isError = false;

        try {
          result = await callMcpTool(name, input);
        } catch (err) {
          result = { error: err.message };
          isError = true;
        }

        toolTrace.push({ name, input, result });

        toolResultContent.push({
          toolResult: {
            toolUseId,
            content: [{ json: result }],
            status: isError ? 'error' : 'success',
          },
        });
      }

      messages.push({ role: 'user', content: toolResultContent });
    }

    if (finalReply === null) {
      finalReply = "I wasn't able to finish processing that request — please try again.";
    }

    res.json({
      reply: finalReply,
      toolTrace,
      history: messages,
    });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;