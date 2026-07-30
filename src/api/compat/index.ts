// DELETE IN P12
/**
 * The legacy surface, kept alive so P10's cutover is an env-var change and
 * nothing else. Every file in this directory is temporary and says so.
 *
 * Paths are mounted exactly as `routes/index.ts` mounts them. The gateway
 * strips `/api/communication`, so these are root-mounted and a legacy caller's
 * URL is unchanged.
 *
 * Three things every compat response carries:
 *
 *  - `Deprecation: true` and `Link: </v1/…>; rel="successor-version"`, so a
 *    consumer can find the replacement without reading this repo.
 *  - a `outreach_compat_hits_total{path}` increment. **That counter is how P12
 *    decides what is safe to delete** — an endpoint with no hits for a release
 *    goes, one with hits does not, and neither judgement should be a guess.
 *  - the legacy vocabulary, both ways (`translate.ts`).
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
import { createLegacyAiRouter } from './ai.js';
import { createLegacyApprovalRouter } from './approvals.js';
import { createLegacyCommunicationsRouter } from './communications.js';
import { createLegacyConfigRouter } from './config.js';
import { createLegacyEventRouter } from './events.js';
import { createLegacyGenerationRouters } from './generation.js';
import { createLegacyMessagesRouter } from './messages.js';
import { createLegacyPreferenceRouter } from './preferences.js';
import { createLegacyPackRouters } from './packs.js';
import { createLegacyQueueRouter } from './queue.js';
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
    { path: '/email', router: send.email },
    { path: '/sms', router: send.sms },
    { path: '/slack', router: send.slack },
    {
      path: '/events',
      router: createLegacyEventRouter({ playbooks: deps.playbooks, identity }),
    },
    // providers-service' event client posts to `/api/events`, not `/events`
    // (`communication-service-client.ts` defaults its base URL to the gateway
    // and keeps the `/api` prefix). Both mounts are required; the source only
    // ever worked because the gateway happened to route it.
    {
      path: '/api/events',
      router: createLegacyEventRouter({ playbooks: deps.playbooks, identity }),
    },
    {
      path: '/preferences',
      router: createLegacyPreferenceRouter({
        ...deps.recipients,
        configs: deps.channels.configs,
        identity,
      }),
    },
    { path: '/config', router: createLegacyConfigRouter(deps.channels) },
    { path: '/approvals', router: createLegacyApprovalRouter(deps.approvals) },
    {
      path: '/communications',
      router: createLegacyCommunicationsRouter({
        ...deps.messaging,
        identity,
        receipts: deps.receipts,
        // One drafting path, two URLs: `/communications/generate-message` and
        // `/ai-enhanced/generate-communication` produce the same approval row.
        draft: generation.draft,
      }),
    },
    {
      path: '/messages',
      router: createLegacyMessagesRouter({
        receipts: deps.receipts,
        messages: deps.messaging.messages,
        playbooks: deps.playbooks,
        identity,
      }),
    },
    { path: '/queue', router: createLegacyQueueRouter(deps.channels) },
    { path: '/templates', router: createLegacyTemplateRouter(deps.content) },
    { path: '/ai', router: createLegacyAiRouter(deps.content) },
    { path: '/ai-enhanced', router: generation.aiEnhanced },
    { path: '/automated-messages', router: generation.automated },
    { path: '/ehr-webhook', router: packRouters.ehrWebhook },
    { path: '/leads', router: packRouters.leads },
    { path: '/treatments', router: packRouters.treatments },
    { path: '/patients', router: packRouters.patients },
    { path: '/providers', router: packRouters.providers },
    { path: '/promotions', router: packRouters.promotions },
    // `routes/index.ts:96` mounts the promotion router twice and something
    // depends on the alias. Same router, same instance.
    { path: '/gift-cards', router: packRouters.promotions },
  ];
}
