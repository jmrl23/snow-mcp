import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectHttp } from './http.js';

describe('connectHttp', () => {
  it('starts an HTTP server on the requested port and responds to MCP initialize', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0 }); // 0 = ephemeral
    try {
      const url = `http://127.0.0.1:${handle.port}/mcp`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    } finally {
      await handle.close();
    }
  });
});
