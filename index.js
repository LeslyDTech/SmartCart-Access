import 'dotenv/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Initialize the Bedrock client
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

export const MCP_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_PORT = 3000;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function commaSeparated(value) {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host) {
  return LOCAL_HOSTS.includes(host);
}

function sendJsonRpcError(res, status, message, code = -32000) {
  return res.status(status).type('application/json').json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

function tokensMatch(candidate, expected) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function bearerTokenAuthentication(expectedToken) {
  return (req, res, next) => {
    if (!expectedToken) {
      next();
      return;
    }

    const authorization = req.get('authorization');
    const match = authorization?.match(/^Bearer (.+)$/i);

    if (!match || !tokensMatch(match[1], expectedToken)) {
      sendJsonRpcError(res, 401, 'Unauthorized');
      return;
    }

    next();
  };
}

function originValidation(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    const originAllowed = !origin || origin === sameOrigin || allowedOrigins.includes(origin);

    if (!originAllowed) {
      sendJsonRpcError(res, 403, `Invalid Origin header: ${origin}`);
      return;
    }

    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res
        .status(204)
        .setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
        .setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id')
        .end();
      return;
    }

    next();
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: 'smartcart-alexa',
    version: '0.1.0'
  });

  server.registerTool(
    'verify_delivery',
    {
      title: 'Verify delivery',
      description: 'Queries AWS Kiro Crew to check if a delivery driver is scheduled.',
      inputSchema: {
        type: 'object',
        properties: { driverId: { type: 'string', description: 'The ID of the delivery driver' } },
        required: ['driverId']
      }
    },
    async (request) => {
      const driverId = request.driverId; 
      console.log(`Checking AWS Kiro Crew for driver: ${driverId}...`);

      if (driverId === 'DRV-8829') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ verified: true, timeWindow: '5 minutes' }) }]
        };
      }
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ verified: false, reason: 'No delivery scheduled' }) }],
        isError: true
      };
    }
  );

  server.registerTool(
    'unlock_door',
    {
      title: 'Unlock door',
      description: 'Issues a command to the Ring API to unlock the door for a verified delivery.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string', description: 'The Ring device ID to unlock' } },
        required: ['deviceId']
      }
    },
    async (request) => {
      const deviceId = request.deviceId;
      console.log(`Sending unlock command to Ring device: ${deviceId}`);

      try {
        const response = await fetch(`https://api.ring.com/v1/devices/${deviceId}/unlock`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RING_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          throw new Error(`Ring API responded with status: ${response.status}`);
        }

        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, apiResponse: data }) }]
        };
      } catch (error) {
        console.error('Ring API Error:', error);
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true
        };
      }
    }
  );

  return server;
} 

async function createSession(sessions) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: sessionId => {
      sessions.set(sessionId, { server, transport });
    },
    onsessionclosed: async sessionId => {
      sessions.delete(sessionId);
      await server.close();
    }
  });

  await server.connect(transport);
  return transport;
}

function validateSubsequentRequest(req, res, sessions) {
  const sessionId = req.get('mcp-session-id');
  if (!sessionId) {
    sendJsonRpcError(res, 400, 'MCP-Session-Id header is required after initialization.');
    return undefined;
  }

  if (req.get('mcp-protocol-version') !== MCP_PROTOCOL_VERSION) {
    sendJsonRpcError(res, 400, `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}.`);
    return undefined;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendJsonRpcError(res, 404, 'Session not found.');
    return undefined;
  }

  return session;
}

export function createApp({
  host = process.env.HOST ?? '127.0.0.1',
  allowedHosts = commaSeparated(process.env.MCP_ALLOWED_HOSTS),
  allowedOrigins = commaSeparated(process.env.MCP_ALLOWED_ORIGINS),
  authToken = process.env.MCP_AUTH_TOKEN
} = {}) {
  if (allowedHosts.length === 0) {
    if (!isLoopbackHost(host)) {
      throw new Error('Set MCP_ALLOWED_HOSTS when HOST is not a loopback address.');
    }
    allowedHosts = LOCAL_HOSTS;
  }

  if (!isLoopbackHost(host) && !authToken) {
    throw new Error('Set MCP_AUTH_TOKEN when HOST is not a loopback address.');
  }

  const sessions = new Map();
  const app = express();

  // Route to serve your HTML web simulator UI
  app.use(express.static('public'));

  app.use(hostHeaderValidation(allowedHosts));
  app.use(originValidation(allowedOrigins));
  app.use(bearerTokenAuthentication(authToken));
  app.use(express.json({ limit: '1mb', strict: true }));

  // The primary MCP tool execution route
  app.post('/mcp', async (req, res, next) => {
    try {
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
        sendJsonRpcError(res, 400, 'Request body must be one JSON-RPC message.', -32600);
        return;
      }

      if (req.body.method === 'initialize') {
        const requestedVersion = req.body.params?.protocolVersion;
        const headerVersion = req.get('mcp-protocol-version');

        if (
          req.get('mcp-session-id') ||
          requestedVersion !== MCP_PROTOCOL_VERSION ||
          (headerVersion && headerVersion !== MCP_PROTOCOL_VERSION)
        ) {
          sendJsonRpcError(res, 400, `Only MCP ${MCP_PROTOCOL_VERSION} initialization is supported.`);
          return;
        }

        const transport = await createSession(sessions);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const session = validateSubsequentRequest(req, res, sessions);
      if (!session) return;

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  // The multi-turn chat route with history and tool tracing
  app.post('/api/chat', async (req, res) => {
    try {
      const userMessage = req.body.message;
      const history = req.body.history || []; 
      
      const systemPrompt = "You are the SmartCart Access Alexa+ Agent. You manage delivery access. You MUST use the verify_delivery tool to check IDs. After verifying, you MUST STOP and ask the user for confirmation. DO NOT unlock the door until the user explicitly approves. When approved, use the unlock_door tool.";

      const messages = [...history, { role: "user", content: [{ text: userMessage }] }];
      let toolTrace = []; 

      const tools = [
        {
          toolSpec: {
            name: "verify_delivery",
            description: "Queries AWS Kiro Crew to check if a delivery driver is scheduled.",
            inputSchema: { json: { type: "object", properties: { driverId: { type: "string" } }, required: ["driverId"] } }
          }
        },
        {
          toolSpec: {
            name: "unlock_door",
            description: "Issues a command to the Ring API to unlock the door.",
            inputSchema: { json: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } }
          }
        }
      ];

      let command = new ConverseCommand({
        modelId: "us.amazon.nova-lite-v1:0", 
        system: [{ text: systemPrompt }],
        messages: messages,
        inferenceConfig: { maxTokens: 512, temperature: 0.5 },
        toolConfig: { tools: tools }
      });

      let response = await bedrockClient.send(command);
      let contentBlocks = response.output.message.content;
      
      const toolUseBlock = contentBlocks.find(block => block.toolUse);

      if (toolUseBlock) {
        const toolName = toolUseBlock.toolUse.name;
        const toolArgs = toolUseBlock.toolUse.input;
        const toolUseId = toolUseBlock.toolUse.toolUseId;
        
        messages.push({ role: "assistant", content: contentBlocks });

        let toolResultJson = {};
        if (toolName === "verify_delivery") {
          if (toolArgs.driverId === 'DRV-8829') {
             toolResultJson = { verified: true, timeWindow: '5 minutes' };
          } else {
             toolResultJson = { verified: false, reason: 'No delivery scheduled' };
          }
        } else if (toolName === "unlock_door") {
             toolResultJson = { success: true, message: "Ring API unlocked the door." };
        }

        toolTrace.push({ name: toolName, input: toolArgs, result: toolResultJson });

        messages.push({
          role: "user",
          content: [{ toolResult: { toolUseId: toolUseId, content: [{ json: toolResultJson }] } }]
        });

        command = new ConverseCommand({
          modelId: "us.amazon.nova-lite-v1:0",
          system: [{ text: systemPrompt }],
          messages: messages,
          inferenceConfig: { maxTokens: 512, temperature: 0.5 },
          toolConfig: { tools: tools }
        });

        response = await bedrockClient.send(command);
        const finalAgentReply = response.output.message.content[0].text.trim();
        messages.push({ role: "assistant", content: [{ text: finalAgentReply }] });
        
        res.json({ reply: finalAgentReply, toolTrace: toolTrace, history: messages });
      } else {
        const agentReply = contentBlocks[0].text.trim();
        messages.push({ role: "assistant", content: [{ text: agentReply }] });
        res.json({ reply: agentReply, toolTrace: [], history: messages });
      }

    } catch (error) {
      console.error("Bedrock Error:", error);
      res.status(500).json({ error: "Failed to communicate with AWS Bedrock." });
    }
  });

  const handleExistingSession = async (req, res, next) => {
    try {
      const session = validateSubsequentRequest(req, res, sessions);
      if (!session) return;

      await session.transport.handleRequest(req, res);
    } catch (error) {
      next(error);
    }
  };

  app.get('/mcp', handleExistingSession);
  app.delete('/mcp', handleExistingSession);
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'GET, POST, DELETE');
    sendJsonRpcError(res, 405, 'Method not allowed.');
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;

    if (error?.type === 'entity.parse.failed') {
      sendJsonRpcError(res, 400, 'Parse error: Invalid JSON.', -32700);
      return;
    }

    console.error('Unhandled MCP server error:', error);
    sendJsonRpcError(res, 500, 'Internal server error.', -32603);
  });

  return app;
}

export function startServer({ port = Number(process.env.PORT ?? DEFAULT_PORT), ...options } = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const app = createApp({ host, ...options });
  return app.listen(port, host, () => {
    console.log(`SmartCart MCP server (MCP ${MCP_PROTOCOL_VERSION}) listening at http://${host}:${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer();
}