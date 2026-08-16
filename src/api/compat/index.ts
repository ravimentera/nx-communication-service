/**
 * The legacy surface, **trimmed to what actually reaches it** (P12, D100).
 *
 * Paths are mounted exactly as the source's `routes/index.ts` mounted them. The
 * gateway strips `/api/communication`, so these are root-mounted and a legacy
 * caller's URL is unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ~24 ENDPOINTS AND NOT 110
 *
 * The shim was built to carry all 110 so that unknown callers on live traffic
 * would not break during a parallel run. There is no live traffic and there are
 * no unknown callers (D99), so the ~86 nothing reaches are gone.
 *
 * **The set was established by inspection, not by measurement.** The plan's
 * method was to read 30 days of `outreach_compat_hits_total` and delete every
 * path with no hits. That cannot work here — a counter records what was called,
 * and nothing is calling — and inspection is the better instrument anyway: it
 * reports what *can* reach the surface, where a counter only reports what did.
 *
 * The six consumers, and what each one calls:
 *
 *   mentera_app (web)      /approvals/{approve,decline,edit,edit-approve}
 *                          /communications/{create-communication,generate-message,
 *                                           message,conversation/:p/:pt/read-all}
 *                          /automated-messages/generate
 *   mentera_app (mobile)   /approvals/{pending,approve,decline,edit-approve}
 *                          /communications/{provider/:id/inbox,conversation/:p/:pt,
 *                                           conversation/:p/:pt/read-all,message,
 *                                           generate-message}
 *                          /automated-messages/generate
 *   providers-service      /email/send, /config/medspa[/:id],
 *                          /templates[/:id][/render], POST /api/events
 *   scheduling-service     POST /events
 *   tera-orchestrator      /mcp/*      (its own mount, not here)
 *   patient-service        /v1/recipients/by-external-ref/…   (already v1)
 *
 * ONE LIMIT OF THE METHOD, STATED RATHER THAN GLOSSED: provider callback URLs
 * live in Twilio's and SendGrid's dashboards, not in any repository, so no grep
 * can prove they are unused. `/messages/webhook/*` and `/ehr-webhook/*` are kept
 * for that reason alone. Everything else was proven unreachable.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things every surviving compat response carries:
 *
 *  - `Deprecation: true` and `Link: </v1/…>; rel="successor-version"`, so a
 *    consumer can find the replacement without reading this repo.
 *  - the legacy vocabulary, both ways (`translate.ts`).
 *
 * `outreach_compat_hits_total` is still incremented. Its purpose has changed:
 * it no longer decides deletions, it confirms that what survived is what is
 * used — a mount that stays at zero after the cutover is one this trim should
 * have caught.
 *
 * What is deliberately *not* preserved: the source's habit of answering 500
 * with `{success:false, message:'…'}` for every failure including bad input.
 * Errors go through the platform error handler, which produces the right status
 * code. A legacy consumer that only checks `success` sees no difference.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';

import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { ApprovalApiDeps } from '../v1/approvals.js';
import type { ChannelApiDeps } from '../v1/channels.js';
import type { ContentApiDeps } from '../v1/content.js';
import type { ReceiptService } from '../../engine/messaging/receipt.service.js';
import type { ContextRegistry } from '../../engine/context/registry.js';
import type { MessagingApiDeps } from '../v1/messaging.js';
import type { PlaybookApiDeps } from '../v1/playbooks.js';
import type { RecipientApiDeps } from '../v1/recipients.js';
import { createLegacyApprovalRouter } from './approvals.js';
import { createLegacyCommunicationsRouter } from './communications.js';
import { createLegacyConfigRouter } from './config.js';
import { createLegacyEventRouter } from './events.js';
import { createLegacyGenerationRouters } from './generation.js';
import { createLegacyMessagesRouter } from './messages.js';
import { createLegacyPackRouters } from './packs.js';
import { createLegacySendRouters } from './send.js';
import { createLegacyTemplateRouter } from './templates.js';
import { CompatIdentity } from './translate.js';

export const compatHitsTotal = new promClient.Counter({
  name: 'outreach_compat_hits_total',
  help: 'Requests served by the legacy compatibility shim, by mounted path',
  labelNames: ['path', 'method'] as const,
  registers: [metricsRegistry],
});

/**
 * Marks a router's whole subtree deprecated and counts it.
 *
 * `req.baseUrl + req.route.path` would be the precise label, but `route` is not
 * populated until after the handler matches, and a label per concrete id would
 * blow up cardinality. The mount prefix plus the method is the granularity P12
 * actually needs: "is anything still calling /approvals?"
 */
export function deprecate(mount: string, successor: string): RequestHandler {
  return (req: Request, res: Response, next) => {
    compatHitsTotal.inc({ path: mount, method: req.method });
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `<${successor}>; rel="successor-version"`);
    next();
  };
}

/**
 * Every legacy mount this shim used to carry and no longer does, with its
 * successor. Mounted as a `410 Gone` so a caller the trim missed gets a sentence
 * naming what happened, instead of a bare 404 indistinguishable from a typo.
 *
 * `410` and not `404` on purpose: it is the difference between "this never
 * existed" and "this existed, it is gone, here is where it went". The inspection
 * that produced this list (D100) is a complete answer for everything inside this
 * repository and mentera_core; it cannot see a URL configured in a third party's
 * dashboard, and this is the cheap insurance against that.
 */
export const RETIRED_MOUNTS: Record<string, string> = {
  '/sms': 'POST /v1/messages with {channel:"sms"}',
  '/slack': 'POST /v1/messages with {channel:"slack"}',
  '/preferences': '/v1/recipients/:id/preferences, /v1/preferences/*',
  '/queue': '/v1/queue/stats',
  '/ai': 'POST /v1/content/generate with a mode discriminator',
  '/ai-enhanced': 'POST /v1/outreach/generate and /v1/approvals',
  '/leads': '/v1/recipients and POST /v1/outreach/trigger',
  '/treatments': 'POST /v1/outreach/trigger',
  '/patients': 'POST /v1/outreach/trigger',
  '/providers': 'GET /v1/analytics/feedback',
  '/promotions': 'POST /v1/outreach/trigger and /v1/campaigns',
  '/gift-cards': 'POST /v1/outreach/trigger',
};

/** One router per retired mount, answering 410 with the successor named. */
export function createRetiredMounts(): Array<{ path: string; router: Router }> {
  return Object.entries(RETIRED_MOUNTS).map(([path, successor]) => {
    const router = Router();
    router.all(/.*/, (req: Request, res: Response) => {
      // Counted, so a retired path that is somehow still being called shows up
      // as a number rather than as a support ticket.
      compatHitsTotal.inc({ path: `${path} (retired)`, method: req.method });
      res.status(410).json({
        success: false,
        error: {
          code: 'GONE',
          message: `The legacy ${path} surface was retired. Use ${successor}.`,
          successor,
        },
      });
    });
    return { path, router };
  });
}

export interface CompatDeps {
  messaging: MessagingApiDeps;
  channels: ChannelApiDeps;
  approvals: ApprovalApiDeps;
  playbooks: PlaybookApiDeps;
  recipients: RecipientApiDeps;
  content: ContentApiDeps;
  receipts: ReceiptService;
  context: ContextRegistry;
}

/**
 * Returns the mounts rather than an app, so `app.ts` keeps one place where
 * ordering is decided.
 */
export function createCompatMounts(deps: CompatDeps): Array<{ path: string; router: Router }> {
  const identity = new CompatIdentity(deps.messaging.recipients);
  const send = createLegacySendRouters({
    dispatcher: deps.messaging.dispatcher,
    identity,
    templates: deps.content.store,
    renderer: deps.content.renderer,
  });

  const generation = createLegacyGenerationRouters({
    content: deps.content,
    approvals: deps.approvals,
    messaging: deps.messaging,
    playbooks: deps.playbooks,
    context: deps.context,
    identity,
  });
  const packRouters = createLegacyPackRouters({
    playbooks: deps.playbooks,
    messaging: deps.messaging,
    packs: deps.content.packs,
    identity,
  });

  return [
    // providers-service, for verification / invitation / password-reset mail.
    { path: '/email', router: send.email },

    // scheduling-service posts to `/events`; providers-service posts to
    // `/api/events`, because `communication-service-client.ts` defaults its base
    // URL to the gateway and keeps the `/api` prefix. Both mounts are required;
    // the source only ever worked because the gateway happened to route it.
    {
      path: '/events',
      router: createLegacyEventRouter({ playbooks: deps.playbooks, identity }),
    },
    {
      path: '/api/events',
      router: createLegacyEventRouter({ playbooks: deps.playbooks, identity }),
    },

    // providers-service' integration-settings screen.
    { path: '/config', router: createLegacyConfigRouter(deps.channels) },

    // The approvals inbox, web and mobile.
    { path: '/approvals', router: createLegacyApprovalRouter(deps.approvals) },

    // The message inbox and composer, web and mobile.
    {
      path: '/communications',
      router: createLegacyCommunicationsRouter({
        ...deps.messaging,
        identity,
        receipts: deps.receipts,
        draft: generation.draft,
      }),
    },

    // KEPT WITHOUT PROOF OF USE. Twilio and SendGrid hold their callback URLs in
    // their own dashboards, so no grep over this repo or mentera_core can show
    // whether these are configured. Deleting them would be a guess whose failure
    // mode is silently losing every delivery receipt and inbound reply.
    // `/v1/webhooks/*` is the successor; retire these once the provider consoles
    // have been checked and repointed.
    {
      path: '/messages',
      router: createLegacyMessagesRouter({
        receipts: deps.receipts,
        messages: deps.messaging.messages,
        playbooks: deps.playbooks,
        identity,
      }),
    },
    // Same reasoning: an EHR vendor posts here from its own configuration.
    { path: '/ehr-webhook', router: packRouters.ehrWebhook },

    // providers-service proxies the template surface (Seam A).
    { path: '/templates', router: createLegacyTemplateRouter(deps.content) },

    // Web and mobile both call `/automated-messages/generate`.
    { path: '/automated-messages', router: generation.automated },
  ];
}
