import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
    const handle = await connectHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
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
    const handle = await connectHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
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
    const handle = await connectHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
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
    const handle = await connectHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
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
    const handle = await connectHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
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

describe('connectHttp full MCP handshake', () => {
  // Register a dummy tool so the server advertises the tools capability and tools/list returns an array.
  const makeServer = () => {
    const s = new McpServer({ name: 'test', version: '0.0.0' });
    s.registerTool(
      'echo',
      { description: 'echo input', inputSchema: { msg: z.string() } },
      async (args) => ({ content: [{ type: 'text' as const, text: args.msg }] }),
    );
    return s;
  };
  const AUTH = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TEST_TOKEN}`,
  };

  it('initialize returns 200 with capabilities', async () => {
    const handle = await connectHttp(makeServer, {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      const body = (await res.json()) as { result?: { capabilities?: unknown } };
      expect(res.status).toBe(200);
      expect(body.result?.capabilities).toBeDefined();
    } finally {
      await handle.close();
    }
  });

  it('notifications/initialized after initialize returns 202', async () => {
    const handle = await connectHttp(makeServer, {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
    try {
      // First: initialize
      await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      // Second: notifications/initialized (a JSON-RPC notification — no id, no response body)
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });
      expect(res.status).toBe(202);
    } finally {
      await handle.close();
    }
  });

  it('tools/list after full handshake returns 200 with tools array', async () => {
    const handle = await connectHttp(makeServer, {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
    try {
      // initialize
      await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      // notifications/initialized
      await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });
      // tools/list
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const body = (await res.json()) as { result?: { tools?: unknown[] } };
      expect(res.status).toBe(200);
      expect(Array.isArray(body.result?.tools)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('repeated initialize calls both succeed (two independent clients)', async () => {
    const handle = await connectHttp(makeServer, {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
    try {
      const res1 = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      const res2 = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('factory error is surfaced via console.error and returns 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A factory that throws causes server.connect to never be reached; the catch block must log it.
    const throwingFactory = () => {
      throw new Error('factory intentionally failed');
    };
    const handle = await connectHttp(throwingFactory, {
      host: '127.0.0.1',
      port: 0,
      authToken: TEST_TOKEN,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: AUTH,
        body: INITIALIZE_BODY,
      });
      expect(res.status).toBe(500);
      // Verify the logged message does not contain the bearer token from the request.
      const logged = spy.mock.calls.flat().join(' ');
      expect(logged).not.toContain(TEST_TOKEN);
    } finally {
      await handle.close();
      spy.mockRestore();
    }
  });
});
