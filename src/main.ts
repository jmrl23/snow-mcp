import { createClient } from 'redis';
import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer, createServerCaches, createRedisServerCaches } from './mcp/server.js';
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
      'buildServer() does not support MCP_TRANSPORT=http — the HTTP path requires a connected Redis client and is wired only in main(). Use stdio transport for buildServer() in tests, or invoke main() directly.',
    );
    err.name = 'UnsupportedTransportError';
    throw err;
  }

  // stdio is single-client: create one server instance and wrap it in a memoizing factory.
  const caches = createServerCaches(config.cache);
  const server = createMcpServer(client, caches);
  return { serverFactory: () => server, config };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const snowClient = createServiceNowClient(config);

  if (config.transport.kind === 'http') {
    // HTTP transport: connect Redis, build Redis-backed caches.
    const redisClient = createClient({ url: config.redis!.url });
    // NOTE: node-redis v5 emits 'error' continuously when disconnected.
    // Attaching this listener before connect() prevents unhandled-error process crashes.
    redisClient.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Redis client error:', redactSecrets(msg));
    });
    await redisClient.connect();

    try {
      const caches = createRedisServerCaches(redisClient, config.cache);
      const handle = await connectTransport(
        () => createMcpServer(snowClient, caches),
        config.transport,
      );

      // Close Redis after the HTTP server shuts down.
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        await redisClient.quit();
      };
    } catch (err) {
      await redisClient.quit().catch(() => {});
      throw err;
    }
    return;
  }

  // stdio path: in-memory caches, no Redis.
  const caches = createServerCaches(config.cache);
  const server = createMcpServer(snowClient, caches);
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
