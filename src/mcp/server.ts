import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import { createSchemaCache } from '../servicenow/schema-cache.js';
import { createListTablesTool } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

export function createMcpServer(client: ServiceNowClient): McpServer {
  const server = new McpServer({ name: 'snow-mcp', version: '1.0.0' });

  for (const tool of [
    createListTablesTool(
      client,
      createSchemaCache<{ name: string; label: string; super_class?: string }[]>({
        ttlMs: 0,
        maxEntries: 0,
      }),
    ),
    createDescribeTableTool(client, createSchemaCache({ ttlMs: 0, maxEntries: 0 })),
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
