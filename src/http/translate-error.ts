import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';
import { parseRetryAfter } from './retry.js';

export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = await parseBody(res);
  const msg = `ServiceNow responded ${res.status} ${res.statusText}`.trim();
  if (res.status === 401 || res.status === 403) {
    throw new ServiceNowAuthError(res.status, body, msg);
  }
  if (res.status === 404) {
    throw new ServiceNowNotFoundError(res.status, body, msg);
  }
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after') ?? '');
    throw new ServiceNowRateLimitError(res.status, body, msg, retryAfterMs);
  }
  if (res.status >= 500) {
    throw new ServiceNowServerError(res.status, body, msg);
  }
  throw new ServiceNowClientError(res.status, body, msg);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
