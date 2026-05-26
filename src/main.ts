import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';
import { connectTransport } from './mcp/transport/index.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): {
  server: McpServer;
  config: ServerConfig;
} {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);
  const server = createMcpServer(client, config.cache);
  return { server, config };
}

async function main(): Promise<void> {
  const { server, config } = buildServer();
  await connectTransport(server, config.transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
