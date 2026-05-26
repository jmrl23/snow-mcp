import type { TableApi, QueryResult } from './table-api.js';

export interface ReportRunOptions {
  limit?: number;
  offset?: number;
}

export interface ReportRunResult {
  records: Record<string, unknown>[];
  total?: number;
  next_offset?: number;
  definition: { table: string; columns: string[] };
}

export interface ReportApi {
  runSavedReport(reportSysId: string, opts: ReportRunOptions): Promise<ReportRunResult>;
}

export function createReportApi(tableApi: TableApi): ReportApi {
  return {
    async runSavedReport(reportSysId, opts) {
      const report = (await tableApi.getRecord('sys_report', reportSysId, [
        'type',
        'table',
        'filter',
        'field_list',
      ])) as {
        type?: string;
        table?: string;
        filter?: string;
        field_list?: string;
      };
      if (report.type !== 'list') {
        throw new Error(`unsupported_report_type: ${report.type ?? 'unknown'}`);
      }
      const columns = (report.field_list ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const result: QueryResult = await tableApi.query(report.table ?? '', {
        sysparmQuery: report.filter ?? undefined,
        fields: columns.length ? columns : undefined,
        limit: opts.limit ?? 25,
        offset: opts.offset ?? 0,
      });
      return {
        records: result.records as Record<string, unknown>[],
        total: result.total,
        next_offset: result.next_offset,
        definition: { table: report.table ?? '', columns },
      };
    },
  };
}
