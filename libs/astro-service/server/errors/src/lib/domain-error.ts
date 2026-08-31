/**
 * Base class for domain-level errors.
 *
 * Unlike the reference repo's dead `SyncRouteDomainError` — which no exception filter ever
 * mapped, so every use case ended up throwing Nest's HTTP exceptions directly — this class
 * carries its own `httpStatus` and is mapped by `AllExceptionsFilter`. Domain and
 * application code throws these; only `entry-points/http` may throw Nest HTTP exceptions.
 *
 * `code` is the stable, machine-readable contract with clients. `message` is for humans and
 * may change freely. Never put anything sensitive in `details` — it is returned to callers.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
    // Required so `instanceof` survives the ES5/ES2021 downlevel of extending a builtin.
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

/** 400 — the request is malformed or violates a business rule that is the caller's fault. */
export class ValidationError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 400, details);
  }
}

/** 401 — no usable identity. Missing, malformed, expired or forged credentials. */
export class UnauthorizedError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 401, details);
  }
}

/** 403 — authenticated, but not allowed to do this. */
export class ForbiddenError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 403, details);
  }
}

/** 404 — the resource does not exist, or the caller may not know that it does. */
export class NotFoundError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 404, details);
  }
}

/** 409 — the request conflicts with current state (lost a race, duplicate, wrong status). */
export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

/** 422 — well-formed and permitted, but cannot be carried out (e.g. insufficient balance). */
export class UnprocessableError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 422, details);
  }
}

/** 429 — rate limited. */
export class TooManyRequestsError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 429, details);
  }
}

/** 503 — a dependency we require is unavailable. Retryable. */
export class ServiceUnavailableError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 503, details);
  }
}
