/**
 * Bad input on a path parameter is a 4xx, and a duplicate key is a 409.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE EXISTS
 *
 * Thirty-seven routes answered **500** for a non-uuid path parameter. Postgres
 * rejects the literal at parse time — `invalid input syntax for type uuid` —
 * and that surfaced through the generic handler as `INTERNAL_ERROR`, with the
 * driver's message reaching the client outside production.
 *
 * `docs/api/BREAKING.md` lists "every 4xx gets the real status code" as
 * something the extraction FIXED: the source answered 500 with
 * `{success:false, message}` for bad input as well as for genuine failures.
 * That was true for request bodies, which go through Zod, and untrue for path
 * parameters — so a caller could not tell "you sent nonsense" from "the service
 * is broken", and a typo paged whoever watches the 5xx rate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT TESTS THE OUTCOME, NOT THE MECHANISM
 *
 * The guard is a `router.param` handler on most routers and per-route
 * middleware on the two that accept an id *or a key*. This suite deliberately
 * knows about neither: it walks the live router stack, sends a real request per
 * route with a non-uuid in the parameter, and looks at the status.
 *
 * That matters because the failure mode being defended against is **a new route
 * added without the guard**. A test that asserted "this router has a param
 * handler" would pass for a router whose newest route takes `:campaignId`
 * instead of `:id`. A test that sends the request cannot be fooled that way.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import request from 'supertest';

import { gatewayHeaders, startHarness, TENANT, type Harness } from './legacy/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const NOT_A_UUID = 'not-a-uuid';

/**
 * Parameters that are NOT uuids and must keep accepting arbitrary strings.
 * Substituting a non-uuid into one of these is not a test of anything.
 */
const NON_UUID_PARAMS = new Set([
  // A sender is an opaque string — `provider-1`, not a uuid.
  'senderId',
  'providerId',
  // Deliberately someone else's identifier: the whole point of the route.
  'system',
  'externalId',
  // Not ids at all.
  'key',
  'packId',
  'token',
  'toolName',
  'type',
  'medspaId',
]);

/**
 * Routes where a non-uuid is a **legitimate lookup**, not bad input.
 *
 * `templates.get` branches on the shape of its argument and falls back to a key
 * lookup (`content/store.ts`), so `GET /v1/templates/welcome-email` is a
 * supported call that must reach the store and answer 404 when no such key
 * exists. Its siblings — update, delete, set-default, versions — take the value
 * straight to a `uuid` column and are guarded.
 *
 * Each entry is a decision, not a formality: adding one says "a non-uuid is
 * meaningful here", and that has to be true.
 */
const ID_OR_KEY = new Set([
  'GET /v1/templates/:id',
  'POST /v1/templates/:id/render',
  'GET /templates/:id',
]);

interface Found {
  method: string;
  path: string;
  params: string[];
}

/** Walk the mounted router tree and collect every route carrying a path param. */
function routesWithParams(app: Harness['app']): Found[] {
  const found: Found[] = [];

  const mountPath = (re?: RegExp): string => {
    if (!re) return '';
    const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(re.source);
    return m ? `/${m[1].replace(/\\\//g, '/')}` : '';
  };

  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
      };

      if (layer.route) {
        const path = layer.route.path === '/' && prefix ? prefix : prefix + layer.route.path;
        const params = [...path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
        if (params.length) {
          for (const method of Object.keys(layer.route.methods)) {
            if (method === '_all') continue;
            found.push({ method: method.toUpperCase(), path, params });
          }
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer.regexp));
      }
    }
  };

  walk((app as unknown as { _router: { stack: unknown[] } })._router.stack, '');
  return found;
}

describe('a non-uuid path parameter', () => {
  it('never produces a 5xx, on any route that takes one', async () => {
    const routes = routesWithParams(h.app).filter((r) =>
      r.params.some((p) => !NON_UUID_PARAMS.has(p)),
    );

    // If this ever reaches zero the walker has broken and the suite is
    // asserting nothing — which is a worse failure than a 500, because it is
    // silent.
    expect(routes.length).toBeGreaterThan(20);

    const failures: string[] = [];

    for (const route of routes) {
      const concrete = route.path.replace(/:(\w+)/g, (_m, name: string) =>
        NON_UUID_PARAMS.has(name) ? 'provider-1' : NOT_A_UUID,
      );

      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
      const res = await request(h.app)
        [method](concrete)
        .set(gatewayHeaders())
        .send({});

      if (res.status >= 500) {
        failures.push(`${route.method} ${route.path} → ${res.status} ${JSON.stringify(res.body)}`);
      }
    }

    expect(failures).toEqual([]);
  }, 180_000);

  it('is rejected as a 400 naming the parameter, not a 404', async () => {
    // 400 rather than 404 on purpose. The engine CAN tell "this cannot be an
    // id" from "valid id, no such row", so it should say which — a 404 here
    // would claim we looked and found nothing, and we never looked.
    const res = await request(h.app)
      .get(`/v1/messages/${NOT_A_UUID}`)
      .set(gatewayHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('must be a UUID');
    expect(res.body.error.details).toMatchObject({ param: 'id' });
  });

  it('does not leak the database driver’s message', async () => {
    const res = await request(h.app)
      .get(`/v1/messages/${NOT_A_UUID}`)
      .set(gatewayHeaders());

    expect(JSON.stringify(res.body)).not.toContain('invalid input syntax');
    expect(JSON.stringify(res.body)).not.toContain('uuid:');
  });

  it('still answers 404 for a well-formed id that does not exist', async () => {
    // The regression this guards: "make it a 400" applied too broadly would
    // turn every miss into a 400 and lose the distinction entirely.
    const res = await request(h.app)
      .get('/v1/messages/00000000-0000-4000-8000-0000000009ff')
      .set(gatewayHeaders());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('leaves the id-or-key routes able to take a key', async () => {
    // A key lookup must reach the store and miss, not be rejected at the edge.
    const res = await request(h.app)
      .get('/v1/templates/some-template-key')
      .set(gatewayHeaders());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(ID_OR_KEY.has('GET /v1/templates/:id')).toBe(true);
  });
});

describe('a duplicate key', () => {
  const body = {
    key: 'dup.contract.test',
    name: 'Duplicate contract fixture',
    channel: 'email',
    content: 'Hello',
  };

  it('is a 409, not a 500', async () => {
    const first = await request(h.app)
      .post('/v1/templates')
      .set(gatewayHeaders())
      .send(body);
    expect(first.status).toBe(201);

    // `templates` carries UNIQUE(tenant_id, key). The second create used to
    // answer 500 with the raw constraint name in the message — so a
    // well-written client retried, and every retry produced the same 500.
    const second = await request(h.app)
      .post('/v1/templates')
      .set(gatewayHeaders())
      .send(body);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('names the constraint but not the conflicting values', async () => {
    const again = await request(h.app)
      .post('/v1/templates')
      .set(gatewayHeaders())
      .send(body);

    // The constraint names the columns, which is what a caller needs to fix it,
    // and is schema shape rather than anyone's data.
    expect(again.body.error.details?.constraint).toContain('templates');

    // Postgres puts the conflicting VALUES in `detail`, which on a
    // tenant-scoped constraint means another row's contents. It must not ship.
    const serialized = JSON.stringify(again.body);
    expect(serialized).not.toContain('already exists.');
    expect(serialized).not.toContain(TENANT);
  });

  it('does not swallow a genuine create', async () => {
    const res = await request(h.app)
      .post('/v1/templates')
      .set(gatewayHeaders())
      .send({ ...body, key: 'dup.contract.test.distinct' });

    expect(res.status).toBe(201);
  });
});
