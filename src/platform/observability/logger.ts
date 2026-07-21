/**
 * Structured logger factory — vendored from
 * `@mentera/shared-libs/observability/logger.ts`.
 *
 * Divergence: the source read LOG_LEVEL / LOG_DIR / LOG_TO_FILE from
 * `process.env` directly. Here every value is passed in, because `src/config/`
 * is the only module allowed to touch the environment (enforced by eslint).
 *
 * Emits structured JSON with a stable shape:
 *   { timestamp, level, service, message, requestId?, tenantId?, userId?, ...meta }
 * to stdout (for container log drivers) and, optionally, to a rotating file.
 */
import path from 'node:path';
import winston from 'winston';

import { getRequestContext } from './context.js';

/** Merge the active request context into every log record. */
const contextFormat = winston.format((info) => {
  const ctx = getRequestContext();
  if (ctx) {
    if (info.requestId === undefined) info.requestId = ctx.requestId;
    if (info.tenantId === undefined && ctx.tenantId) info.tenantId = ctx.tenantId;
    if (info.subTenantId === undefined && ctx.subTenantId) info.subTenantId = ctx.subTenantId;
    if (info.userId === undefined && ctx.userId) info.userId = ctx.userId;
  }
  return info;
});

export interface ServiceLoggerOptions {
  level?: string;
  /** Directory for the rotating file transport. */
  logDir?: string;
  /** Enable the file transport. Default false — containers log to stdout. */
  fileTransport?: boolean;
}

const loggerCache = new Map<string, winston.Logger>();

export function createServiceLogger(
  service: string,
  options: ServiceLoggerOptions = {},
): winston.Logger {
  const cached = loggerCache.get(service);
  if (cached) return cached;

  const level = options.level ?? 'info';
  const transports: winston.transport[] = [new winston.transports.Console({ level })];

  if (options.fileTransport) {
    transports.push(
      new winston.transports.File({
        filename: path.join(options.logDir ?? 'logs', `${service}.log`),
        level,
        // Cap disk usage: 25MB x 3 files, newest always <service>.log
        maxsize: 25 * 1024 * 1024,
        maxFiles: 3,
        tailable: true,
      }),
    );
  }

  const logger = winston.createLogger({
    level,
    defaultMeta: { service },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      contextFormat(),
      winston.format.json(),
    ),
    transports,
  });

  loggerCache.set(service, logger);
  return logger;
}

/** Test-only: drop the cache so a fresh logger can be built. */
export function resetLoggerCache(): void {
  loggerCache.clear();
}
