import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export type AggregateOperation = 'count' | 'avg' | 'sum' | 'min' | 'max';

export interface AggregateOptions {
  operation: AggregateOperation;
  field?: string;
  groupBy?: string[];
  sysparmQuery?: string;
}

export interface AggregateResult {
  group: Record<string, string>;
  value: number;
}

export interface AggregateApi {
  aggregate(table: string, opts: AggregateOptions): Promise<AggregateResult[]>;
}

export function createAggregateApi(http: HttpClient): AggregateApi {
  return {
    async aggregate(table, opts) {
      if (opts.operation !== 'count' && !opts.field) {
        throw new Error(`aggregate operation "${opts.operation}" requires a field`);
      }
      const query: Record<string, string | undefined> = {
        sysparm_query: opts.sysparmQuery,
        sysparm_group_by: opts.groupBy?.length ? opts.groupBy.join(',') : undefined,
      };
      switch (opts.operation) {
        case 'count':
          query.sysparm_count = 'true';
          break;
        case 'avg':
          query.sysparm_avg_fields = opts.field;
          break;
        case 'sum':
          query.sysparm_sum_fields = opts.field;
          break;
        case 'min':
          query.sysparm_min_fields = opts.field;
          break;
        case 'max':
          query.sysparm_max_fields = opts.field;
          break;
      }
      const res = await http.request(`/api/now/stats/${encodeURIComponent(table)}`, { query });
      const ok = await ensureOk(res);
      type AggregateRow = {
        groupby_fields?: Array<{ field: string; value: string }>;
        stats?: Record<string, unknown>;
      };
      const body = (await ok.json()) as { result?: AggregateRow | AggregateRow[] };
      // ServiceNow returns a single object when not grouped, an array when grouped.
      const rows: AggregateRow[] = Array.isArray(body.result)
        ? body.result
        : body.result
          ? [body.result]
          : [];
      return rows.map((row) => ({
        group: Object.fromEntries((row.groupby_fields ?? []).map((g) => [g.field, g.value])),
        value: extractStat(row.stats ?? {}, opts),
      }));
    },
  };
}

function extractStat(stats: Record<string, unknown>, opts: AggregateOptions): number {
  if (opts.operation === 'count') {
    return Number(stats.count ?? 0);
  }
  const bucket = stats[opts.operation] as Record<string, unknown> | undefined;
  if (!bucket || !opts.field) return NaN;
  return Number(bucket[opts.field] ?? NaN);
}
