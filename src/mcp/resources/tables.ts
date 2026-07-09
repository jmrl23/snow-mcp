import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';

export interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

export interface TablesResource {
  uri: 'servicenow://tables';
  name: 'tables';
  description: string;
  mimeType: 'application/json';
  read(): Promise<ResourceContents>;
}

const CACHE_KEY = 'servicenow://tables';

export function createTablesResource(
  client: ServiceNowClient,
  cache: ResourceCache,
): TablesResource {
  return {
    uri: 'servicenow://tables',
    name: 'tables',
    description: 'Live catalog of ServiceNow tables visible to the authenticated user.',
    mimeType: 'application/json',
    async read() {
      const cached = await cache.get<ResourceContents>('catalog', CACHE_KEY);
      if (cached !== undefined) return cached;

      const out = await client.table.query<{
        name: string;
        label: string;
        super_class?: string;
        sys_id: string;
      }>('sys_db_object', {
        fields: ['name', 'label', 'super_class', 'sys_id'],
        limit: 10000,
        offset: 0,
      });
      const text = JSON.stringify(
        out.records.map((r) => ({
          name: r.name,
          label: r.label,
          super_class: r.super_class,
          sys_id: r.sys_id,
        })),
        null,
        2,
      );
      const result: ResourceContents = {
        contents: [{ uri: 'servicenow://tables', mimeType: 'application/json', text }],
      };
      await cache.set('catalog', CACHE_KEY, result);
      return result;
    },
  };
}
