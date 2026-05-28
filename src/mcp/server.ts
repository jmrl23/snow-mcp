import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { RedisClientType } from 'redis';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import { createSchemaCache, type SchemaCache } from '../servicenow/schema-cache.js';
import { createRedisSchemaCache } from '../servicenow/schema-cache-redis.js';
import { createListTablesTool, type CachedRow } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

export const DESCRIBE_CACHE_NAMESPACE = 'snow-mcp:describe';
export const LIST_CACHE_NAMESPACE = 'snow-mcp:list';

// NOTE: createClient() returns RedisClientType<RedisDefaultModules & M, ...> which is not
// assignable to RedisClientType<M, ...>. Using Pick narrows to the operations we actually
// call, which both the real client and test fakes satisfy without casts.
type RedisOps = Pick<RedisClientType, 'get' | 'set' | 'scan' | 'del'>;

export interface ServerCaches {
  describeCache: SchemaCache<unknown>;
  listCache: SchemaCache<CachedRow[]>;
}

export function createServerCaches(cacheConfig: CacheConfig): ServerCaches {
  return {
    describeCache: createSchemaCache<unknown>(cacheConfig),
    listCache: createSchemaCache<CachedRow[]>(cacheConfig),
  };
}

export function createRedisServerCaches(redis: RedisOps, cacheConfig: CacheConfig): ServerCaches {
  return {
    describeCache: createRedisSchemaCache<unknown>(redis, {
      ttlMs: cacheConfig.ttlMs,
      namespace: DESCRIBE_CACHE_NAMESPACE,
    }),
    listCache: createRedisSchemaCache<CachedRow[]>(redis, {
      ttlMs: cacheConfig.ttlMs,
      namespace: LIST_CACHE_NAMESPACE,
    }),
  };
}

export function createMcpServer(client: ServiceNowClient, caches: ServerCaches): McpServer {
  // NOTE: keep in sync with package.json "version". tsconfig rootDir=./src blocks importing it directly.
  const server = new McpServer({ name: 'snow-mcp', version: '1.1.0' });
  const { describeCache, listCache } = caches;

  for (const tool of [
    createListTablesTool(client, listCache),
    createDescribeTableTool(client, describeCache),
    createQueryTableTool(client),
    createGetRecordTool(client),
    createGetAttachmentTool(client),
    createAggregateTool(client),
    createRunSavedReportTool(client),
    createGetUserContextTool(client),
  ]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      (async (args: Record<string, unknown>) =>
        (await tool.handler(args as never)) as unknown as CallToolResult) as never,
    );
  }

  const tables = createTablesResource(client);
  server.registerResource(
    tables.name,
    tables.uri,
    { description: tables.description, mimeType: tables.mimeType },
    (async () => (await tables.read()) as unknown as ReadResourceResult) as never,
  );

  return server;
}
