/**
 * Authentication — vendored from `@mentera/shared-libs/middleware/auth.middleware.ts`
 * with the tenancy generalization from §0.7 and a pluggable trust mode.
 *
 * Two changes worth knowing about:
 *
 *  1. DUAL HEADERS. For the whole parallel-run window the service accepts both
 *     the new names and the Mentera ones (x-tenant-id / x-medspa-id, etc.), new
 *     name winning. P12 removes the fallbacks.
 *
 *  2. AUTH_MODE. The source hardcoded "trust the gateway". That is fine inside
 *     Mentera and useless to a vendor with no Mentera gateway in front. `gateway`
 *     is implemented; `apikey` and `jwt` are explicit 501s so the seam exists
 *     without pretending to be secure.
 *
 * Kept: the gateway-only gate, the skip paths, per-route bypass rules, and
 * requirePermissions' admin short-circuit.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'winston';

import { AuthError, ForbiddenError, NotImplementedError } from './errors.js';

export enum UserRole {
  PROVIDER = 'provider',
  ADMIN = 'admin',
  STAFF = 'staff',
  SYSTEM = 'system',
}

/**
 * Outreach-scoped permissions. The Mentera `Permission` enum is deliberately NOT
 * carried over — it enumerated provider/medspa/expertise grants that mean
 * nothing to this service.
 */
export enum Permission {
  SEND = 'outreach:send',
  APPROVE = 'outreach:approve',
  APPROVE_BULK = 'outreach:approve:bulk',
  TEMPLATES_WRITE = 'outreach:templates:write',
  PLAYBOOKS_WRITE = 'outreach:playbooks:write',
  CONFIG_WRITE = 'outreach:config:write',
  ADMIN = 'outreach:admin',
}

export interface RequestIdentity {
  userId: string;
  role: string;
  email?: string;
  tenantId: string;
  subTenantId?: string;
  /** The agent on whose behalf we send. Was providerId. */
  senderId?: string;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: RequestIdentity;
      requestId?: string;
    }
  }
}

export type AuthMode = 'gateway' | 'apikey' | 'jwt';

export interface AuthConfig {
  mode: AuthMode;
  /** Reject anything that did not arrive through the gateway. Default true. */
  gatewayOnly?: boolean;
}

export interface AuthMiddlewareOptions {
  config: AuthConfig;
  logger: Logger;
  /** Paths that skip auth entirely. Default: /health, /docs, /public. */
  skipPaths?: string[];
  /** Per-route bypasses: path -> { method, param, value }. */
  bypassRules?: Record<string, { method: string; param: string; value: string }>;
}

const DEFAULT_SKIP_PATHS = ['/health', '/docs', '/public'];

/** First header that has a value wins. */
function firstHeader(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) return value;
  }
  return undefined;
}

function parsePermissions(raw: string | undefined, logger: Logger): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    logger.warn('failed to parse x-user-permissions; treating as empty', { raw });
    return [];
  }
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  const { config, logger } = options;
  const skipPaths = options.skipPaths ?? DEFAULT_SKIP_PATHS;
  const bypassRules = options.bypassRules ?? {};
  const gatewayOnly = config.gatewayOnly ?? true;

  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const rule = bypassRules[req.path];
      if (rule && rule.method === req.method && req.query[rule.param] === rule.value) {
        return next();
      }

      if (
        req.method === 'OPTIONS' ||
        (req.baseUrl === '' && req.path === '/') ||
        skipPaths.some((p) => req.path === p || req.path.startsWith(`${p}/`))
      ) {
        return next();
      }

      if (config.mode === 'apikey') {
        // The tenant_api_keys table lands in P2; the lookup is wired in P12.
        return next(
          new NotImplementedError('AUTH_MODE=apikey is not wired yet (planned for P12)'),
        );
      }
      if (config.mode === 'jwt') {
        return next(new NotImplementedError('AUTH_MODE=jwt is not implemented'));
      }

      if (gatewayOnly) {
        const fromGateway =
          req.headers['x-gateway-request'] === 'true' ||
          req.headers['x-internal-request'] === 'gateway';

        if (!fromGateway) {
          logger.warn('rejecting non-gateway request', {
            path: req.path,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          return next(
            new ForbiddenError('This service only accepts requests through the API gateway'),
          );
        }
      }

      const userId = firstHeader(req, 'x-user-id');
      const role = firstHeader(req, 'x-user-role');

      if (!userId || !role) {
        logger.warn('gateway request missing user context', {
          path: req.path,
          userId: userId ?? 'missing',
          role: role ?? 'missing',
        });
        return next(new AuthError('Missing user context from gateway'));
      }

      req.identity = {
        userId,
        role,
        email: firstHeader(req, 'x-user-email'),
        tenantId: firstHeader(req, 'x-tenant-id', 'x-medspa-id') ?? '',
        subTenantId: firstHeader(req, 'x-sub-tenant-id', 'x-location-id'),
        senderId: firstHeader(req, 'x-sender-id', 'x-provider-id'),
        permissions: parsePermissions(firstHeader(req, 'x-user-permissions'), logger),
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Require permissions. Admins always pass, by role or by the admin permission.
 */
export function requirePermissions(...required: (Permission | string)[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const identity = req.identity;
    if (!identity) return next(new AuthError());

    if (identity.role === UserRole.ADMIN || identity.permissions.includes(Permission.ADMIN)) {
      return next();
    }

    const missing = required.filter((p) => !identity.permissions.includes(p));
    if (missing.length > 0) {
      return next(
        new ForbiddenError('You do not have permission to access this resource', { missing }),
      );
    }

    return next();
  };
}

/**
 * The tenant scope for the current request. Never read the tenant from a body or
 * a query param — it comes from the identity the middleware resolved (§0.9).
 */
export function requireTenant(req: Request): { tenantId: string; subTenantId?: string } {
  const identity = req.identity;
  if (!identity?.tenantId) {
    throw new AuthError('No tenant on this request');
  }
  return { tenantId: identity.tenantId, subTenantId: identity.subTenantId };
}
