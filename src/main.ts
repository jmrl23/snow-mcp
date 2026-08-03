import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';
import { connectTransport } from './mcp/transport/index.js';
import { redactSecrets } from './log-redact.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): {
  serverFactory: () => McpServer;
  config: ServerConfig;
} {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);

  if (config.transport.kind === 'http') {
    const err = new Error(
      'buildServer() does not support MCP_TRANSPORT=http — the HTTP path requires per-request server instances and is wired only in main(). Use stdio transport for buildServer() in tests, or invoke main() directly.',
    );
    err.name = 'UnsupportedTransportError';
    throw err;
  }

  const server = createMcpServer(client);
  return { serverFactory: () => server, config };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const snowClient = createServiceNowClient(config);

  if (config.transport.kind === 'http') {
    await connectTransport(() => createMcpServer(snowClient), config.transport);
    return;
  }

  const server = createMcpServer(snowClient);
  await connectTransport(() => server, config.transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(redactSecrets(raw));
    process.exit(1);
  });
}
