import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export interface QueryOptions {
  sysparmQuery?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: 'true' | 'false' | 'all';
}

export interface QueryResult<T = Record<string, unknown>> {
  records: T[];
  total?: number;
  next_offset?: number;
}

export interface TableApi {
  query<T = Record<string, unknown>>(table: string, opts: QueryOptions): Promise<QueryResult<T>>;
  getRecord<T = Record<string, unknown>>(
    table: string,
    sysId: string,
    fields?: string[],
  ): Promise<T>;
}

export function createTableApi(http: HttpClient): TableApi {
  return {
    async query<T = Record<string, unknown>>(table: string, opts: QueryOptions) {
      const limit = opts.limit ?? 25;
      const offset = opts.offset ?? 0;
      const res = await http.request(`/api/now/table/${encodeURIComponent(table)}`, {
        query: {
          sysparm_query: opts.sysparmQuery,
          sysparm_fields: opts.fields?.length ? opts.fields.join(',') : undefined,
          sysparm_limit: String(limit),
          sysparm_offset: String(offset),
          sysparm_display_value: opts.displayValue ?? 'false',
        },
      });
      const ok = await ensureOk(res);
      const totalHeader = ok.headers.get('x-total-count');
      const total = totalHeader ? Number(totalHeader) : undefined;
      const body = (await ok.json()) as { result?: unknown[] };
      const records = (body.result ?? []) as Record<string, unknown>[];
      const next_offset =
        total !== undefined && offset + records.length < total
          ? offset + records.length
          : undefined;
      return { records, total, next_offset } as QueryResult<T>;
    },

    async getRecord<T = Record<string, unknown>>(table: string, sysId: string, fields?: string[]) {
      const res = await http.request(
        `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
        {
          query: { sysparm_fields: fields?.length ? fields.join(',') : undefined },
        },
      );
      const ok = await ensureOk(res);
      const body = (await ok.json()) as { result?: unknown };
      return body.result as T;
    },
  };
}
