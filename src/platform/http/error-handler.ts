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
