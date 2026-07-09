import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import {
  createResourceCache,
  createNoopResourceCache,
  type ResourceCache,
} from '../cache/resource-cache.js';
import { createListTablesTool } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createClearCacheTool } from './tools/clear-cache.js';
import { createTablesResource } from './resources/tables.js';

export function createServerCaches(cacheConfig: CacheConfig): ResourceCache {
  return createResourceCache(cacheConfig);
}

export function createNoopServerCaches(): ResourceCache {
  return createNoopResourceCache();
}

export function createMcpServer(client: ServiceNowClient, cache: ResourceCache): McpServer {
  // NOTE: keep in sync with package.json "version". tsconfig rootDir=./src blocks importing it directly.
  const server = new McpServer({ name: 'snow-mcp', version: '1.1.0' });

  for (const tool of [
    createListTablesTool(client, cache),
    createDescribeTableTool(client, cache),
    createQueryTableTool(client, cache),
    createGetRecordTool(client, cache),
    createGetAttachmentTool(client),
    createAggregateTool(client, cache),
    createRunSavedReportTool(client, cache),
    createGetUserContextTool(client, cache),
    createClearCacheTool(cache),
  ]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      (async (args: Record<string, unknown>) =>
        (await tool.handler(args as never)) as unknown as CallToolResult) as never,
    );
  }

  const tables = createTablesResource(client, cache);
  server.registerResource(
    tables.name,
    tables.uri,
    { description: tables.description, mimeType: tables.mimeType },
    (async () => (await tables.read()) as unknown as ReadResourceResult) as never,
  );

  return server;
}
