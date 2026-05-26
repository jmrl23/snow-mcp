export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReadOnlyViolationError extends Error {
  constructor(method: string) {
    super(`Read-only violation: HTTP ${method} is not allowed. snow-mcp issues GET requests only.`);
    this.name = 'ReadOnlyViolationError';
  }
}

export class ServiceNowError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceNowError';
  }
}

export class ServiceNowAuthError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowAuthError';
  }
}

export class ServiceNowNotFoundError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowNotFoundError';
  }
}

export class ServiceNowRateLimitError extends ServiceNowError {
  constructor(
    status: number,
    body: unknown,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(status, body, message);
    this.name = 'ServiceNowRateLimitError';
  }
}

export class ServiceNowServerError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowServerError';
  }
}

export class ServiceNowClientError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowClientError';
  }
}
