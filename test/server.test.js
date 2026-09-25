import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp, MCP_PROTOCOL_VERSION } from '../index.js';

let httpServer;
let endpoint;

before(async () => {
  httpServer = createServer(createApp());
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${httpServer.address().port}/mcp`;
});

after(async () => {
  await new Promise(resolve => httpServer.close(resolve));
});

test('serves only MCP 2025-11-25 and exposes inert tool stubs', async () => {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  };
  const initialize = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    })
  });

  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get('mcp-session-id');
  assert.ok(sessionId);
  assert.equal((await initialize.json()).result.protocolVersion, MCP_PROTOCOL_VERSION);

  const sessionHeaders = {
    ...headers,
    'MCP-Session-Id': sessionId,
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
  };
  const initialized = await fetch(endpoint, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.equal(initialized.status, 202);

  const toolsResponse = await fetch(endpoint, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  const tools = (await toolsResponse.json()).result.tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['unlock_door', 'verify_delivery']);

  const toolResponse = await fetch(endpoint, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'unlock_door', arguments: {} }
    })
  });
  assert.equal((await toolResponse.json()).result.isError, true);

  const wrongVersion = await fetch(endpoint, {
    method: 'POST',
    headers: { ...sessionHeaders, 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
  });
  assert.equal(wrongVersion.status, 400);
});
