/**
 * Typed error hierarchy. The source service had a bare 500 handler
 * (`communication-service/src/index.ts:118-126`); this improves on it.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(message, 401, 'UNAUTHENTICATED', details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', details?: unknown) {
    super(message, 429, 'RATE_LIMITED', details);
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented', details?: unknown) {
    super(message, 501, 'NOT_IMPLEMENTED', details);
  }
}

/** A dependency we call out to failed — upstream API, another service. */
export class UpstreamError extends AppError {
  constructor(message = 'Upstream request failed', details?: unknown) {
    super(message, 502, 'UPSTREAM_ERROR', details);
  }
}
