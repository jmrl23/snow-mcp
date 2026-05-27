import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectHttp } from './http.js';

const TEST_TOKEN = 'test-secret-token-abc123';

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
});

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('connectHttp bearer auth', () => {
  it('returns 401 with WWW-Authenticate header when Authorization header is missing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0, authToken: TEST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE_BODY,
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('includes WWW-Authenticate header on 401', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0, authToken: TEST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE_BODY,
      });
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="snow-mcp"');
    } finally {
      await handle.close();
    }
  });

  it('returns 401 when the Bearer token is wrong', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0, authToken: TEST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: 'Bearer wrong-token' },
        body: INITIALIZE_BODY,
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('accepts a lowercase "bearer" scheme (RFC 7235 case-insensitive)', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0, authToken: TEST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `bearer ${TEST_TOKEN}` },
        body: INITIALIZE_BODY,
      });
      expect(res.status).not.toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('responds 2xx to MCP initialize with correct Bearer token', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0, authToken: TEST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${TEST_TOKEN}` },
        body: INITIALIZE_BODY,
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    } finally {
      await handle.close();
    }
  });
});
