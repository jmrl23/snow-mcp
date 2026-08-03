import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from './main.js';

describe('buildServer', () => {
  it('throws ConfigError when env is empty', () => {
    expect(() => buildServer({})).toThrow(/Missing required configuration/);
  });

  it('builds a connectable McpServer when env is valid', () => {
    const { serverFactory } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    // buildServer always returns a factory; calling it yields the McpServer instance.
    expect(serverFactory()).toBeInstanceOf(McpServer);
  });

  it('registers all 8 tools', () => {
    const { serverFactory } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    const server = serverFactory();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });

  it('returns a ServerConfig with transport=stdio by default', () => {
    const { config } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(config.transport.kind).toBe('stdio');
  });

  it('throws when MCP_TRANSPORT=http (HTTP path is wired only in main())', () => {
    expect(() =>
      buildServer({
        SNOW_INSTANCE_URL: 'https://example.service-now.com',
        SNOW_OAUTH_TOKEN: 't',
        MCP_TRANSPORT: 'http',
        MCP_AUTH_TOKEN: 'test-auth-token',
      }),
    ).toThrow(/buildServer\(\) does not support MCP_TRANSPORT=http/);
  });
});
