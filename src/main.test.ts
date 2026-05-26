import { describe, expect, it } from 'vitest';
import { buildServer } from './main.js';

describe('buildServer', () => {
  it('throws ConfigError when env is empty', () => {
    expect(() => buildServer({})).toThrow(/Missing required configuration/);
  });

  it('returns a connectable McpServer when env is valid', () => {
    const server = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(server.server).toBeDefined();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });
});
