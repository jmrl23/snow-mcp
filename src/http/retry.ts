export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  jitterPct: number;
}

const DEFAULT: RetryOptions = { maxAttempts: 3, baseDelayMs: 200, jitterPct: 0.25 };

export async function withRetry(
  fn: () => Promise<Response>,
  opts: Partial<RetryOptions> = {},
): Promise<Response> {
  const cfg = { ...DEFAULT, ...opts };
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      const res = await fn();
      if (!shouldRetryStatus(res.status) || attempt === cfg.maxAttempts - 1) {
        return res;
      }
      lastResponse = res;
      const delay =
        res.status === 429
          ? (parseRetryAfter(res.headers.get('retry-after') ?? '') ?? backoffMs(attempt, cfg))
          : backoffMs(attempt, cfg);
      await sleep(delay);
    } catch (err) {
      if (!isRetryableError(err) || attempt === cfg.maxAttempts - 1) {
        throw err;
      }
      lastError = err;
      await sleep(backoffMs(attempt, cfg));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET'
  );
}

function backoffMs(attempt: number, cfg: RetryOptions): number {
  const base = cfg.baseDelayMs * Math.pow(4, attempt);
  const jitter = base * cfg.jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseRetryAfter(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
