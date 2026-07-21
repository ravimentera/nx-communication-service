/**
 * Observability middleware — vendored from
 * `@mentera/shared-libs/observability/middleware.ts`. One mount gives:
 *
 *  1. Correlation: mints or propagates x-request-id, echoes it on the response,
 *     and opens an AsyncLocalStorage context so every downstream log line
 *     carries requestId/tenantId/userId automatically.
 *  2. Metrics: RED (rate, errors, duration) per service/method/route.
 *  3. Access logs: one structured `http_request` line per completed request,
 *     level scaling with status (info <400, warn 4xx, error 5xx).
 *
 * Divergence: tenant identity is read from x-tenant-id with x-medspa-id as the
 * fallback, matching the auth middleware's dual-header window (§0.7).
 */
import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type winston from 'winston';

import { runWithContext } from './context.js';
import { httpRequestDuration, httpRequestsInFlight, httpRequestsTotal } from './metrics.js';

export interface ObservabilityOptions {
  serviceName: string;
  logger: winston.Logger;
  /** Emit per-request access logs (metrics are always recorded). Default true. */
  logRequests?: boolean;
  /** Paths excluded from both metrics and logs. */
  ignorePaths?: string[];
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SEGMENT = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEGMENT = /^\d+$/;

/**
 * Collapse high-cardinality path segments (UUIDs, numeric ids, long hex tokens)
 * to `:id` so Prometheus route labels stay bounded.
 */
export function normalizeRoutePath(pathname: string): string {
  const queryIndex = pathname.indexOf('?');
  const cleanPath = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);
  const normalized = cleanPath
    .split('/')
    .map((segment) =>
      UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) || HEX_SEGMENT.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');
  return normalized || '/';
}

const DEFAULT_IGNORE = ['/health', '/metrics', '/favicon.ico'];

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

export function createObservabilityMiddleware(options: ObservabilityOptions): RequestHandler {
  const { serviceName, logger, logRequests = true, ignorePaths = DEFAULT_IGNORE } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = header(req, 'x-request-id') || randomUUID();

    // Visible to downstream handlers and echoed to the client.
    (req as Request & { requestId?: string }).requestId = requestId;
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);

    const ignored = ignorePaths.some((p) => req.path === p || req.path.startsWith(`${p}/`));
    if (ignored) {
      return runWithContext({ requestId }, () => next());
    }

    const tenantId = header(req, 'x-tenant-id') || header(req, 'x-medspa-id');
    const subTenantId = header(req, 'x-sub-tenant-id') || header(req, 'x-location-id');
    const userId = header(req, 'x-user-id');
    const startTime = process.hrtime.bigint();

    httpRequestsInFlight.inc({ service: serviceName });

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      httpRequestsInFlight.dec({ service: serviceName });

      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      // Prefer the matched Express route (bounded cardinality); fall back to a
      // normalized raw path for unmatched requests.
      const route = req.route?.path
        ? `${req.baseUrl || ''}${req.route.path}`
        : normalizeRoutePath(req.originalUrl || req.path);

      const labels = {
        service: serviceName,
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, durationSeconds);

      if (logRequests) {
        const meta = {
          requestId,
          method: req.method,
          route,
          path: req.originalUrl || req.path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationSeconds * 1000 * 100) / 100,
          tenantId,
          userId,
          contentLength: res.getHeader('content-length'),
          ip: req.ip,
        };
        if (res.statusCode >= 500) logger.error('http_request', meta);
        else if (res.statusCode >= 400) logger.warn('http_request', meta);
        else logger.info('http_request', meta);
      }
    };

    res.on('finish', finalize);
    res.on('close', finalize);

    return runWithContext({ requestId, tenantId, subTenantId, userId }, () => next());
  };
}
