import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import {
  createSchemaCache,
  createNoopSchemaCache,
  type SchemaCache,
} from '../servicenow/schema-cache.js';
import { createListTablesTool, type CachedRow } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

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

export function createNoopServerCaches(): ServerCaches {
  return {
    describeCache: createNoopSchemaCache<unknown>(),
    listCache: createNoopSchemaCache<CachedRow[]>(),
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
