/**
 * Terminal error handler. Logs with the request id and never leaks a stack
 * trace or an internal message in production.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'winston';
import { ZodError } from 'zod';

import { AppError, NotFoundError } from './errors.js';

export interface ErrorHandlerOptions {
  logger: Logger;
  /** Hide internal messages and stacks from clients. */
  production: boolean;
}

/** What `pg` puts on a `DatabaseError`, narrowed to the fields used here. */
interface PgError {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

/**
 * A unique-constraint violation — Postgres `23505`.
 *
 * Duck-typed rather than `instanceof pg.DatabaseError`, so the HTTP layer does
 * not take a dependency on the driver to classify one integer.
 */
function asUniqueViolation(err: unknown): PgError | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Partial<PgError>;
  return e.code === '23505' ? (e as PgError) : null;
}

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`No route for ${req.method} ${req.path}`));
  };
}

export function createErrorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  const { logger, production } = options;

  return (err, req, res, _next) => {
    const requestId = (req as { requestId?: string }).requestId;

    // Zod failures are client errors, not server errors.
    if (err instanceof ZodError) {
      logger.warn('request validation failed', {
        requestId,
        path: req.path,
        issues: err.issues,
      });
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues },
        requestId,
      });
      return;
    }

    if (err instanceof AppError) {
      const meta = {
        requestId,
        path: req.path,
        code: err.code,
        statusCode: err.statusCode,
        error: err.message,
      };
      if (err.statusCode >= 500) logger.error('request failed', { ...meta, stack: err.stack });
      else logger.warn('request rejected', meta);

      res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          // ── DETAILS ARE FOR 4xx ONLY ────────────────────────────────────
          //
          // A 4xx's `details` tell a caller what to fix — which field, which
          // permission, which allowed values — and that is the whole point of
          // carrying them. A 5xx's tell them about US: an
          // `ChannelNotConfiguredError` carries the tenant id, and a database
          // error carries whatever the driver put there.
          //
          // The log line above already has all of it, correlated by
          // `requestId`, which is what an operator actually debugs from.
          ...(err.statusCode >= 500 && production ? {} : { details: err.details }),
        },
        requestId,
      });
      return;
    }

    // ── unique-constraint violations are 409, not 500 ────────────────────────
    //
    // Creating a resource whose key is taken is a CALLER's situation, and one
    // they can act on: pick another key, or update the existing row. It was
    // answering `500 INTERNAL_ERROR` with the raw constraint name in the
    // message — so a well-written client retried, and every retry produced the
    // same 500. `POST /v1/templates` and `POST /v1/approval-policies` both do
    // this; both tables carry UNIQUE(tenant_id, key).
    //
    // CENTRAL, NOT PER-ROUTE, and the trade-off is deliberate. A duplicate our
    // own code caused — a race inserting the same id twice — now reports 409
    // rather than 500. That is the better failure of the two: 409 is honest
    // about what happened, the caller can retry meaningfully, and the log line
    // below keeps the constraint, table and detail for whoever debugs it. The
    // alternative, hand-catching `23505` at every insert, is a list that is one
    // forgotten `catch` away from being wrong again.
    //
    // Contrast `22P02` (malformed uuid), which is NOT mapped here — see
    // `params.ts` for why that one has to be caught at the edge instead.
    const unique = asUniqueViolation(err);
    if (unique) {
      logger.warn('unique constraint violated', {
        requestId,
        path: req.path,
        constraint: unique.constraint,
        table: unique.table,
        detail: unique.detail,
      });

      res.status(409).json({
        success: false,
        error: {
          code: 'CONFLICT',
          message: 'A record with these values already exists',
          // The constraint names the columns, which is the one thing a caller
          // needs to fix this — and it is schema shape rather than anyone's
          // data, so it is safe to return. `detail` is NOT returned: Postgres
          // puts the conflicting VALUES in it, which on a tenant-scoped
          // constraint means another row's contents.
          ...(unique.constraint ? { details: { constraint: unique.constraint } } : {}),
        },
        requestId,
      });
      return;
    }

    // Anything else is a bug: log everything, tell the client nothing.
    logger.error('unhandled error', {
      requestId,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: production
          ? 'An internal server error occurred'
          : err instanceof Error
            ? err.message
            : String(err),
      },
      requestId,
    });
  };
}
