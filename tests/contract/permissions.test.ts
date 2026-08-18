/**
 * Every mutating `/v1` route is behind a permission.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE EXISTS AT ALL
 *
 * `requirePermissions` has been the convention since P8a, and it was applied by
 * hand, router by router. Two whole routers missed it: `/v1/campaigns` (17
 * routes) and `/v1/recipients` (13), both written in P11 — so any authenticated
 * user in a tenant could launch a campaign to the entire audience, import a
 * lead list, or flip another person's communication preferences, while the
 * single-message `POST /v1/messages` beside them required `outreach:send`.
 *
 * The defect is not that somebody forgot. It is that a convention enforced by
 * memory across thirteen phases and eleven routers will be forgotten, and
 * nothing in the build would say so. This walks the live router stack, the same
 * way the OpenAPI suite does, and fails on the next one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXCEPTIONS ARE NAMED, NOT PATTERNED
 *
 * `UNGATED` is an explicit list and each entry carries its reason. A regex like
 * "anything under /public" would let the next exception in silently, which is
 * the failure mode this suite exists to close — so adding to it is a visible,
 * arguable diff rather than a matching path.
 *
 * GETs are not covered here. Read authorization is per row and per tenant and
 * belongs in the service (see the approvals suite); a blanket permission on
 * reads would say nothing about whether the right rows came back.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { startHarness, type Harness } from './legacy/harness.js';

let h: Harness;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mutating `/v1` routes that deliberately carry no `requirePermissions`.
 * Every entry states why. Adding one is a decision, not a formality.
 */
const UNGATED = new Map<string, string>([
  [
    'POST /v1/preferences/check',
    'A dry run of the compliance gate that writes nothing and sends nothing. ' +
      'It is a read wearing POST because its input does not fit a query string.',
  ],

  // ── provider callbacks ────────────────────────────────────────────────────
  // Mounted before the auth middleware on purpose (app.ts note 2): Twilio and
  // SendGrid carry no gateway headers. The signature IS the credential, and a
  // permission check would reject every real callback while adding nothing.
  ['POST /v1/webhooks/twilio', 'Signature-verified provider callback, pre-auth by design.'],
  ['POST /v1/webhooks/sendgrid', 'Signature-verified provider callback, pre-auth by design.'],
  ['POST /v1/webhooks/slack', 'Signature-verified provider callback, pre-auth by design.'],

  // ── approvals: authorized per row, which is stronger ───────────────────────
  // `ApprovalService.authorize()` runs on every one of these and compares the
  // actor to the approval's own assignee — agent, group or role. A blanket
  // `outreach:approve` would be *weaker*: it would let any holder act on any
  // approval in the tenant, which is precisely the source defect D45 records.
  // The permission is checked there too, for the non-agent cases.
  ['POST /v1/approvals/:id/approve', 'Per-row authorization in ApprovalService.authorize().'],
  ['POST /v1/approvals/:id/edit-approve', 'Per-row authorization in ApprovalService.authorize().'],
  ['PUT /v1/approvals/:id/content', 'Per-row authorization in ApprovalService.authorize().'],
  ['POST /v1/approvals/:id/decline', 'Per-row authorization in ApprovalService.authorize().'],
  ['POST /v1/approvals/:id/schedule', 'Per-row authorization in ApprovalService.authorize().'],
  ['POST /v1/approvals/:id/cancel', 'Per-row authorization in ApprovalService.authorize().'],

  // ── previews ──────────────────────────────────────────────────────────────
  // Render a body and return it. No row is written, nothing is sent, and the
  // caller supplies the source — so there is no privilege to escalate.
  ['POST /v1/content/render', 'Pure render. Writes nothing, sends nothing.'],
  ['POST /v1/templates/:id/render', 'Pure render of a template this tenant already owns.'],

  // ── read state ────────────────────────────────────────────────────────────
  // Marking a message read is tenant-scoped UI state. It changes no
  // configuration and causes no send.
  ['PUT /v1/messages/:id/read', 'Tenant-scoped read receipt; no send, no config change.'],
  [
    'PUT /v1/conversations/:senderId/:recipientId/read-all',
    'Tenant-scoped read receipt; no send, no config change.',
  ],
]);

beforeAll(async () => {
  h = await startHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/**
 * Walk the router stack and report, per route, whether `requirePermissions`
 * is among its handlers.
 *
 * The middleware is identified by function name. `requirePermissions` returns a
 * named function for exactly this reason — an anonymous closure would make this
 * suite unwritable, which is worth knowing if anyone is tempted to inline it.
 */
function mutatingRoutes(app: Harness['app']): { route: string; gated: boolean }[] {
  const found: { route: string; gated: boolean }[] = [];

  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack?: { name?: string }[];
        };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
      };

      if (layer.route) {
        const path = layer.route.path === '/' && prefix ? prefix : prefix + layer.route.path;
        const gated = (layer.route.stack ?? []).some((s) => s.name === 'permissionGate');
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          const upper = method.toUpperCase();
          if (MUTATING.has(upper)) found.push({ route: `${upper} ${path}`, gated });
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer.regexp));
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk(((app as any)._router ?? (app as any).router).stack as unknown[], '');
  return found;
}

function mountPath(regexp: RegExp | undefined): string {
  if (!regexp) return '';
  const source = regexp.source;
  if (source === '^\\/?(?=\\/|$)') return '';
  const match = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
  if (!match?.[1]) return '';
  return '/' + match[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

describe('every mutating /v1 route carries a permission', () => {
  it('has no ungated writes outside the named exceptions', () => {
    const v1 = mutatingRoutes(h.app).filter((r) => r.route.includes(' /v1/'));

    // Guards the walker itself: a regex change that silently matched nothing
    // would make this suite pass by finding no routes to check.
    expect(v1.length).toBeGreaterThan(20);

    const ungated = v1.filter((r) => !r.gated && !UNGATED.has(r.route)).map((r) => r.route);
    expect(ungated).toEqual([]);
  });

  it('keeps the exception list honest — every entry still exists and is still ungated', () => {
    const byRoute = new Map(mutatingRoutes(h.app).map((r) => [r.route, r.gated]));

    for (const route of UNGATED.keys()) {
      expect(byRoute.has(route)).toBe(true);
      // If somebody gated it, the exception is stale and should go.
      expect(byRoute.get(route)).toBe(false);
    }
  });

  it('gates the two routers that shipped without any', () => {
    // Named explicitly because this is the regression, not a general property:
    // /v1/campaigns had 17 routes and /v1/recipients 13, none of them gated.
    const gated = mutatingRoutes(h.app).filter((r) => r.gated).map((r) => r.route);

    expect(gated).toEqual(
      expect.arrayContaining([
        'POST /v1/campaigns',
        'POST /v1/campaigns/:id/launch',
        'POST /v1/audiences',
        'POST /v1/audiences/:id/import',
        'POST /v1/recipients',
        'PUT /v1/recipients/:id/preferences',
        'POST /v1/recipients/:id/consent',
      ]),
    );
  });
});
