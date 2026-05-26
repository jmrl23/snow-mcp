import type { ServerConfig } from '../config.js';
import { createHttpClient } from '../http/client.js';
import { withRetry } from '../http/retry.js';
import type { HttpClient, RequestOptions } from '../http/client.js';
import { createTableApi, type TableApi } from './table-api.js';
import { createAggregateApi, type AggregateApi } from './aggregate-api.js';
import { createAttachmentApi, type AttachmentApi } from './attachment-api.js';
import { createReportApi, type ReportApi } from './report-api.js';
import { createUserContextApi, type UserContextApi } from './user-context.js';

export interface ServiceNowClient {
  table: TableApi;
  aggregate: AggregateApi;
  attachment: AttachmentApi;
  report: ReportApi;
  userContext: UserContextApi;
}

export function createServiceNowClient(
  config: ServerConfig,
  fetchImpl?: typeof fetch,
): ServiceNowClient {
  const base = fetchImpl ? createHttpClient(config, fetchImpl) : createHttpClient(config);
  const http: HttpClient = {
    request: (path: string, opts?: RequestOptions) => withRetry(() => base.request(path, opts)),
    requestRaw: (method, path, opts) => withRetry(() => base.requestRaw(method, path, opts)),
  };
  const table = createTableApi(http);
  return {
    table,
    aggregate: createAggregateApi(http),
    attachment: createAttachmentApi(http),
    report: createReportApi(table),
    userContext: createUserContextApi(table, {
      authenticatedUserName: config.authenticatedUserName,
    }),
  };
}
