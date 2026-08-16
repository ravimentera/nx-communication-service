/**
 * Authentication — vendored from `@mentera/shared-libs/middleware/auth.middleware.ts`
 * with the tenancy generalization from §0.7 and a pluggable trust mode.
 *
 * Two changes worth knowing about:
 *
 *  1. TENANCY HEADERS. **`x-tenant-id` and `x-sub-tenant-id` only** — the
 *     `x-medspa-id` / `x-location-id` aliases were dropped in P12 (D106) once
 *     the gateway started sending the generic names. A vertical noun in the
 *     engine's own wire protocol was the last place "medspa" appeared in
 *     something every caller has to speak.
 *
 *     The alias is NOT deprecated-but-tolerated: a request carrying only
 *     `x-medspa-id` now has no tenant, which fails at `requireTenant` rather
 *     than silently serving something. Tolerating it is how a header alias
 *     survives forever, and the callers are a known, finite set — the gateway,
 *     three service clients and tera-orchestrator, all of which send both.
 *
 *     `x-provider-id` is still accepted as an alias for `x-sender-id`. That one
 *     is untouched: it is a *sender* identity, not the tenancy boundary, and
 *     nothing in this phase established that its callers had moved.
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

import { AuthError, ForbiddenError, NotImplementedError, RateLimitError } from './errors.js';

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
  /** `apikey` mode: requests per key per minute. 0 disables the limit. */
  apiKeyRateLimitPerMinute?: number;
}

/** What `apikey` mode gets back from a successful verification. */
export interface VerifiedApiKey {
  keyId: string;
  tenantId: string;
  scopes: string[];
}

export interface AuthMiddlewareOptions {
  config: AuthConfig;
  logger: Logger;
  /** Paths that skip auth entirely. Default: /health, /docs, /public. */
  skipPaths?: string[];
  /** Per-route bypasses: path -> { method, param, value }. */
  bypassRules?: Record<string, { method: string; param: string; value: string }>;
  /**
   * `apikey` mode: verify a presented key. Injected rather than imported so the
   * platform layer keeps knowing nothing about the database — the same reason
   * every other adapter is constructed in the composition root (§0.9).
   *
   * Absent in `apikey` mode is a boot-time misconfiguration, and the middleware
   * says so rather than letting requests through.
   */
  verifyApiKey?: (presented: string) => Promise<VerifiedApiKey | null>;
  /**
   * `apikey` mode: increment the per-key counter for the current minute and
   * return the new value. Backed by Redis when it is up, per-replica when it is
   * not — a degraded limiter is still a limiter.
   */
  countRequest?: (keyId: string, windowSeconds: number) => Promise<number>;
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

  return (req: Request, res: Response, next: NextFunction) => {
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
        // Async, so it leaves the synchronous path entirely. Errors are routed
        // through `next` inside, not thrown past this frame.
        void authenticateApiKey(req, res, next, options);
        return;
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
        tenantId: firstHeader(req, 'x-tenant-id') ?? '',
        subTenantId: firstHeader(req, 'x-sub-tenant-id'),
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
 * `AUTH_MODE=apikey`. The credential is the key; there is no gateway and no
 * user, so the identity is synthesised from the key's own row.
 *
 * Three things are deliberately NOT taken from a header here:
 *
 *   - **the tenant.** It comes from the key's row and nowhere else. A key that
 *     could name its own tenant is not a tenant boundary, it is a suggestion.
 *   - **the permissions.** They are the key's `scopes`. In gateway mode the
 *     gateway is trusted to have authenticated the user who owns them; there is
 *     no such party here.
 *   - **the role.** Fixed at `system`, so a key can never take the admin
 *     short-circuit in `requirePermissions` by asserting `x-user-role: admin`.
 *
 * The sub-tenant and sender ARE read from headers: both are scoped inside the
 * tenant the key already fixes, so neither widens what the key can reach.
 */
async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
  options: AuthMiddlewareOptions,
): Promise<void> {
  const { config, logger } = options;

  try {
    if (!options.verifyApiKey) {
      // Boot-time misconfiguration. Failing closed, loudly.
      next(
        new NotImplementedError(
          'AUTH_MODE=apikey is set but no key verifier was wired into the auth middleware',
        ),
      );
      return;
    }

    const presented = readApiKey(req);
    if (!presented) {
      next(new AuthError('Provide an API key in Authorization: Bearer <key> or x-api-key'));
      return;
    }

    const verified = await options.verifyApiKey(presented);
    if (!verified) {
      logger.warn('rejecting unknown, revoked or expired api key', {
        path: req.path,
        ip: req.ip,
      });
      // One message for unknown, revoked and expired alike: a caller holding a
      // revoked key and a caller guessing should learn the same thing.
      next(new AuthError('Invalid API key'));
      return;
    }

    const limit = config.apiKeyRateLimitPerMinute ?? 0;
    if (limit > 0 && options.countRequest) {
      const used = await options.countRequest(verified.keyId, 60);
      if (used > limit) {
        logger.warn('api key rate limit exceeded', { keyId: verified.keyId, used, limit });
        res.setHeader('Retry-After', '60');
        next(
          new RateLimitError(`API key rate limit of ${limit} requests per minute exceeded`, {
            limit,
          }),
        );
        return;
      }
    }

    req.identity = {
      userId: `apikey:${verified.keyId}`,
      role: UserRole.SYSTEM,
      tenantId: verified.tenantId,
      subTenantId: firstHeader(req, 'x-sub-tenant-id'),
      senderId: firstHeader(req, 'x-sender-id', 'x-provider-id'),
      permissions: verified.scopes,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** `Authorization: Bearer <key>` first, then `x-api-key`. */
function readApiKey(req: Request): string | undefined {
  const authorization = firstHeader(req, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim();
    if (value) return value;
  }
  return firstHeader(req, 'x-api-key');
}

/**
 * Require permissions. Admins always pass, by role or by the admin permission.
 */
export function requirePermissions(...required: (Permission | string)[]): RequestHandler {
  // Named, not anonymous, and that is load-bearing: `tests/contract/
  // permissions.test.ts` walks the live router stack and identifies the gate by
  // this name. Two whole routers shipped without a permission check because the
  // convention was enforced by memory; the test is what replaced the memory, and
  // inlining this as an arrow would blind it.
  return function permissionGate(req: Request, _res: Response, next: NextFunction) {
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
