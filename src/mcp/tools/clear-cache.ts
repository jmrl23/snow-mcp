import { z } from 'zod';
import { CACHE_KINDS, type CacheKind, type ResourceCache } from '../../cache/resource-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const clearCacheInput = {
  kind: z
    .enum(CACHE_KINDS)
    .optional()
    .describe('Limit the clear to one cache kind. Omit to clear everything.'),
};

export interface ClearCacheTool {
  name: 'clear_cache';
  description: string;
  inputShape: typeof clearCacheInput;
  handler(input: { kind?: CacheKind }): Promise<McpResult>;
}

export function createClearCacheTool(cache: ResourceCache): ClearCacheTool {
  return {
    name: 'clear_cache',
    description:
      'Clear cached ServiceNow data so the next read is fetched live. Optionally scope to one cache kind (schema, catalog, user_context, record, aggregate, report).',
    inputShape: clearCacheInput,
    handler: (input) => runTool(async () => ({ clearedCount: await cache.clear(input.kind) })),
  };
}
