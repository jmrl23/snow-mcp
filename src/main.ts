import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);
  return createMcpServer(client, config.cache);
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
