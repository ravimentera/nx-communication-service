/**
 * Path-parameter validation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A path parameter that reaches a `uuid` column unvalidated is a **500**, not a
 * 400: Postgres rejects the literal at parse time with
 * `invalid input syntax for type uuid: "not-a-uuid"`, and that error surfaces
 * through the generic handler as `INTERNAL_ERROR`. Thirty-seven routes did
 * this.
 *
 * Two things were wrong with it, in increasing order of importance:
 *
 *   1. The driver's message reached the client outside production, naming the
 *      column type. Small, and free to stop.
 *
 *   2. The status was a lie. `docs/api/BREAKING.md` lists "every 4xx gets the
 *      real status code" as something the extraction FIXED — the source
 *      answered 500 with `{success:false, message}` for bad input as well as
 *      for genuine failures. That was true for bodies, which go through Zod,
 *      and untrue for path parameters. A caller could not tell "you sent
 *      nonsense" from "the service is broken", which is exactly the distinction
 *      that row promises, and a 5xx rate alert pages someone for a typo.
 *
 * WHY NOT MAP THE POSTGRES ERROR CENTRALLY INSTEAD
 *
 * Catching `22P02` in the error handler and calling it a 400 would be fewer
 * lines and would cover routes nobody remembered. It was rejected because it
 * cannot tell the two causes apart: a malformed value from the CALLER is a 400,
 * and a malformed value our own code constructed is a bug that must stay a 500.
 * Mapping the code centrally would silently downgrade the second kind forever.
 *
 * Validating at the edge keeps that distinction: the caller's mistake is
 * rejected here with a message naming the parameter, and a `22P02` that still
 * escapes is genuinely ours.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { RequestHandler, RequestParamHandler } from 'express';

import { ValidationError } from './errors.js';

/** Accepts any RFC 4122 layout. Version and variant are Postgres's business. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function reject(name: string, value: unknown): ValidationError {
  return new ValidationError(`'${name}' must be a UUID`, {
    param: name,
    // The caller's own input, echoed back so they can see what was read —
    // bounded, because a path segment is caller-controlled and unbounded.
    received: typeof value === 'string' ? value.slice(0, 100) : value,
  });
}

/**
 * For `router.param(name, …)` — validates once per request, before any handler
 * on that router sees the value.
 *
 * Prefer this where **every** route on a router treats the parameter as a uuid.
 * It cannot be forgotten when a route is added later, which per-route
 * middleware can.
 */
export function uuidParam(): RequestParamHandler {
  return (_req, _res, next, value, name) => {
    if (isUuid(value)) {
      next();
      return;
    }
    next(reject(name, value));
  };
}

/**
 * Per-route form, for routers where the same parameter name is a uuid on some
 * routes and something else on others.
 *
 * One router needs this: `/v1/templates/:id` accepts an id **or a key**
 * (`content/store.ts` — `get` branches on the shape), so a non-uuid there is a
 * legitimate key lookup that must reach the store. Its sibling routes —
 * delete, update, set-default, versions — take the id straight to a `uuid`
 * column and do not.
 */
export function requireUuidParams(...names: string[]): RequestHandler {
  return (req, _res, next) => {
    for (const name of names) {
      const value = req.params[name];
      if (!isUuid(value)) {
        next(reject(name, value));
        return;
      }
    }
    next();
  };
}
