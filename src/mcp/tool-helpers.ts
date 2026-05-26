import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';
import { redact } from '../http/client.js';

export interface McpResult {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | Record<string, unknown>
  >;
  isError?: boolean;
}

export function toMcpResult(value: unknown): McpResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export async function runTool(handler: () => Promise<unknown>): Promise<McpResult> {
  try {
    const value = await handler();
    return toMcpResult(value);
  } catch (err) {
    return toErrorResult(err);
  }
}

function toErrorResult(err: unknown): McpResult {
  if (err instanceof ServiceNowNotFoundError) return errorBlock('not_found', err.status, err.body);
  if (err instanceof ServiceNowAuthError) return errorBlock('auth_error', err.status, err.body);
  if (err instanceof ServiceNowRateLimitError)
    return errorBlock('rate_limited', err.status, err.body, { retry_after_ms: err.retryAfterMs });
  if (err instanceof ServiceNowServerError)
    return errorBlock('upstream_error', err.status, err.body);
  if (err instanceof ServiceNowClientError) return errorBlock('client_error', err.status, err.body);
  const message = err instanceof Error ? err.message : String(err);
  return errorBlock('internal_error', 0, { message });
}

function errorBlock(
  code: string,
  status: number,
  body: unknown,
  extra?: Record<string, unknown>,
): McpResult {
  const payload = { error: { code, status, body: redact(body), ...extra } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
