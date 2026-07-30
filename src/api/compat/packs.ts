// DELETE IN P12
/**
 * The pack-shaped routers: `/ehr-webhook` (3), `/leads` (3), `/treatments` (1),
 * `/patients` (2), `/providers` (1), `/promotions` + `/gift-cards`.
 *
 * Every one of these is a **playbook trigger with a URL**. The source gives
 * each its own route file, its own service, and in five cases its own table —
 * `lead_profiles`, `treatment_follow_up_rules`, `outreach_rules`,
 * `farewell_messages`, `promotions`/`gift_cards` — all of which are ghost
 * tables: empty in production, absent from the migrations, tenant-blind, and
 * backed by stub code that returns a hardcoded `Jane Smith` (D11).
 *
 * So there is nothing to port but the trigger. `POST /treatments/:id/follow-up`
 * becomes `medspa.treatment-followup`; `/patients/:id/onboarding` becomes
 * `medspa.onboarding`; and so on. §0.7 has the full table.
 *
 * **`/gift-cards` is mounted to the same router as `/promotions`**
 * (`routes/index.ts:96`) and something depends on the alias, so both mounts
 * exist here too.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { mapEhrEvent } from '../../engine/playbooks/ehr-mapper.js';
import type { PackRegistry } from '../../packs/loader.js';
import type { MessagingApiDeps } from '../v1/messaging.js';
import type { PlaybookApiDeps } from '../v1/playbooks.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { toChannelType } from '../../ports/channel.js';
import { deprecate } from './index.js';
import type { CompatIdentity } from './translate.js';

/** Which pack owns the EHR mapping. One vertical today; a lookup when there are two. */
const EHR_PACK = 'medspa';

const ehrEventSchema = z.object({
  ehrEventType: z.string().min(1),
  ehrSource: z.string().default('unknown'),
  patientId: z.string().min(1),
  providerId: z.string().min(1),
  eventData: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string().optional(),
  externalEventId: z.string().optional(),
});

export interface PackCompatDeps {
  playbooks: PlaybookApiDeps;
  messaging: MessagingApiDeps;
  packs: PackRegistry;
  identity: CompatIdentity;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyPackRouters(deps: PackCompatDeps): {
  ehrWebhook: Router;
  leads: Router;
  treatments: Router;
  patients: Router;
  providers: Router;
  promotions: Router;
} {
  /** Fire a playbook for a legacy patient id and report the runs. */
  async function trigger(
    req: Request,
    input: {
      eventType: string;
      patientId?: string;
      providerId?: string;
      context?: Record<string, unknown>;
      channels?: string[];
      idempotencyKey?: string;
      correlationId?: string;
    },
  ) {
    const scope = requireTenant(req);
    const channels = (input.channels ?? [])
      .map((c) => toChannelType(c))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    return deps.playbooks.runtime.run({
      type: 'event',
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      eventType: input.eventType,
      correlationId: input.correlationId ?? `${input.eventType}:${input.patientId ?? 'none'}`,
      idempotencyKey: input.idempotencyKey,
      recipientId: input.patientId
        ? await deps.identity.ensure(scope, input.patientId)
        : undefined,
      senderId: input.providerId ?? req.identity?.senderId,
      ...(channels.length ? { channels } : {}),
      payload: { context: input.context ?? {} },
    });
  }

  // ── /ehr-webhook ──────────────────────────────────────────────────────────
  const ehrWebhook = Router();
  ehrWebhook.use(deprecate('/ehr-webhook', '/v1/outreach/trigger'));

  const mapping = () => {
    const found = deps.packs.ehrMapping(EHR_PACK);
    if (!found) {
      throw new NotFoundError(
        `No EHR mapping is installed. Add packs/${EHR_PACK}/ehr-mapping.json, or post to /v1/outreach/trigger with the outreach event type directly.`,
      );
    }
    return found;
  };

  ehrWebhook.post(
    '/process-event',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const body = ehrEventSchema.parse(req.body);
      const mapped = mapEhrEvent(mapping(), body);

      if (!mapped) {
        // The source guesses here (`getContextualMapping`) and sends the
        // patient a message chosen by heuristic. 200 with `mapped: false` says
        // what happened without inventing an outreach.
        res.json({
          success: true,
          mapped: false,
          message: `No mapping for EHR event '${body.ehrEventType}'; nothing was sent.`,
          ehrEventType: body.ehrEventType,
        });
        return;
      }

      const results = await trigger(req, {
        eventType: mapped.eventType,
        patientId: body.patientId,
        providerId: body.providerId,
        channels: mapped.channels,
        // The EHR's own event id is the redelivery guard, so a vendor retrying
        // a webhook produces one run rather than a second send.
        idempotencyKey: body.externalEventId,
        correlationId: body.externalEventId,
        context: { ...body.eventData, ...mapped.metadata },
      });

      res.json({
        success: true,
        mapped: true,
        mapping: mapped,
        matched: results.length,
        results,
      });
    }),
  );

  ehrWebhook.post(
    '/bulk-process',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const events = z.array(ehrEventSchema).parse(req.body?.events ?? req.body);
      const results = [];

      for (const event of events) {
        try {
          const mapped = mapEhrEvent(mapping(), event);
          if (!mapped) {
            results.push({ ehrEventType: event.ehrEventType, success: true, mapped: false });
            continue;
          }
          results.push({
            ehrEventType: event.ehrEventType,
            success: true,
            mapped: true,
            results: await trigger(req, {
              eventType: mapped.eventType,
              patientId: event.patientId,
              providerId: event.providerId,
              channels: mapped.channels,
              idempotencyKey: event.externalEventId,
              context: { ...event.eventData, ...mapped.metadata },
            }),
          });
        } catch (error) {
          results.push({
            ehrEventType: event.ehrEventType,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.json({ success: results.every((r) => r.success), results });
    }),
  );

  /**
   * The preview. Genuinely useful, and now honest about *why* a rule matched:
   * the source returns a mapping with a `reasonForDecision` string that is
   * hardcoded next to the rule; here `matchedBy` says whether it was an exact
   * name or a pattern, which is the question an operator debugging a vendor
   * feed actually has.
   */
  ehrWebhook.get(
    '/mapping-preview/:ehrEventType',
    handle(async (req, res) => {
      requireTenant(req);
      const mapped = mapEhrEvent(mapping(), {
        ehrEventType: req.params.ehrEventType as string,
        ehrSource: req.query.source as string | undefined,
      });

      res.json({
        success: true,
        ehrEventType: req.params.ehrEventType,
        mapped: Boolean(mapped),
        mapping: mapped,
      });
    }),
  );

  // ── /leads ────────────────────────────────────────────────────────────────
  const leads = Router();
  leads.use(deprecate('/leads', '/v1/recipients'));

  /**
   * `lead_profiles` is a ghost table (D11) — empty, tenant-blind, absent from
   * the migrations. §0.7 folds it into `recipients.attributes`, so a lead
   * profile is a recipient with attributes and nothing else changes.
   */
  leads.post(
    '/:leadId/profile',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipient = await deps.messaging.recipients.upsertByExternalRef(
        scope,
        { system: 'lead', id: req.params.leadId as string },
        {
          displayName: req.body?.name as string | undefined,
          attributes: (req.body ?? {}) as Record<string, unknown>,
          ...(req.body?.email || req.body?.phone
            ? {
                contactPoints: [
                  ...(req.body.email
                    ? [{ type: 'email', value: req.body.email as string, primary: true }]
                    : []),
                  ...(req.body.phone
                    ? [{ type: 'phone', value: req.body.phone as string, primary: !req.body.email }]
                    : []),
                ],
              }
            : {}),
        },
      );
      res.status(201).json({ success: true, data: { leadId: req.params.leadId, id: recipient.id } });
    }),
  );

  leads.get(
    '/:leadId/profile',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipient = await deps.messaging.recipients.getByExternalRef(scope, {
        system: 'lead',
        id: req.params.leadId as string,
      });
      if (!recipient) throw new NotFoundError('Lead profile not found');
      res.json({
        success: true,
        data: { leadId: req.params.leadId, ...recipient.attributes as object, id: recipient.id },
      });
    }),
  );

  leads.post(
    '/:leadId/message',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipient = await deps.messaging.recipients.getByExternalRef(scope, {
        system: 'lead',
        id: req.params.leadId as string,
      });
      if (!recipient) throw new NotFoundError('Lead profile not found');

      const results = await deps.playbooks.runtime.run({
        type: 'event',
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        eventType: (req.body?.eventType as string) ?? 'LEAD_NURTURE',
        correlationId: `lead:${req.params.leadId}`,
        recipientId: recipient.id,
        senderId: req.identity?.senderId,
        payload: { context: (req.body ?? {}) as Record<string, unknown> },
      });
      res.json({ success: true, matched: results.length, data: results });
    }),
  );

  // ── /treatments, /patients, /providers ────────────────────────────────────
  const treatments = Router();
  treatments.use(deprecate('/treatments', '/v1/outreach/trigger'));
  treatments.post(
    '/:treatmentId/follow-up',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const results = await trigger(req, {
        eventType: 'TREATMENT_FOLLOWUP',
        patientId: req.body?.patientId as string | undefined,
        providerId: req.body?.providerId as string | undefined,
        correlationId: `treatment:${req.params.treatmentId}`,
        context: { treatmentId: req.params.treatmentId, ...(req.body ?? {}) },
      });
      res.json({ success: true, matched: results.length, data: results });
    }),
  );

  const patients = Router();
  patients.use(deprecate('/patients', '/v1/outreach/trigger'));

  for (const [path, eventType] of [
    ['onboarding', 'PATIENT_REGISTRATION'],
    ['farewell', 'PATIENT_FAREWELL'],
  ] as const) {
    patients.post(
      `/:patientId/${path}`,
      requirePermissions(Permission.SEND),
      handle(async (req, res) => {
        const results = await trigger(req, {
          eventType,
          patientId: req.params.patientId as string,
          providerId: req.body?.providerId as string | undefined,
          correlationId: `${path}:${req.params.patientId}`,
          context: (req.body ?? {}) as Record<string, unknown>,
        });
        res.json({ success: true, matched: results.length, data: results });
      }),
    );
  }

  const providers = Router();
  providers.use(deprecate('/providers', '/v1/analytics/messages'));

  /**
   * `GET /providers/:providerId/feedback/adverse` read `patient_feedback`,
   * which is empty and always was (D11), so this has always returned nothing.
   * The concept lives on `message_analytics.metadata` now (§0.7) — the same
   * substitution the inbox alerts use — so the answer is unchanged today and
   * becomes real once the webhooks write sentiment.
   */
  providers.get(
    '/:providerId/feedback/adverse',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const page = await deps.messaging.conversations.inbox(
        scope,
        req.params.providerId as string,
        { limit: 200 },
      );
      const adverse = page.conversations.filter((c) => c.alerts.hasAdverse);
      res.json({ success: true, data: adverse, count: adverse.length });
    }),
  );

  // ── /promotions, aliased as /gift-cards ───────────────────────────────────
  const promotions = Router();
  promotions.use(deprecate('/promotions', '/v1/outreach/trigger'));

  /**
   * `promotions` and `gift_cards` are **not engine tables** (§0.10 tier 3, D12):
   * a gift card balance is a ledger and belongs with commerce. The engine needs
   * the promotion's *fields at render time*, and those arrive with the event.
   *
   * `createTargetedCampaign` — the reason promotions lived in this service — is
   * built on `findEligiblePatients()`, which returns a hardcoded `Jane Smith`
   * and `John Doe` and is commented *"For demo purposes, we'll return stub
   * data"* (`promotion.service.ts:169`). There is nothing behind it to port.
   */
  const promotionTrigger = (eventType: string) =>
    handle(async (req: Request, res: Response) => {
      const results = await trigger(req, {
        eventType,
        patientId: (req.body?.patientId ?? req.params.patientId) as string | undefined,
        providerId: req.body?.providerId as string | undefined,
        correlationId: `promotion:${req.params.promotionId ?? 'adhoc'}`,
        context: { promotion: req.body ?? {} },
      });
      res.json({ success: true, matched: results.length, data: results });
    });

  promotions.post('/', requirePermissions(Permission.SEND), promotionTrigger('PROMOTION'));
  promotions.post('/create', requirePermissions(Permission.SEND), promotionTrigger('PROMOTION'));
  promotions.post(
    '/:promotionId/campaign',
    requirePermissions(Permission.SEND),
    handle(async () => {
      throw new ValidationError(
        'Targeted promotion campaigns are not ported: the source builds them on findEligiblePatients(), which returns hardcoded stub data. Send the audience with POST /v1/outreach/trigger, or wait for campaigns in P11.',
      );
    }),
  );
  promotions.post(
    '/patients/:patientId/feedback',
    requirePermissions(Permission.SEND),
    promotionTrigger('PATIENT_FEEDBACK_REQUEST'),
  );

  return { ehrWebhook, leads, treatments, patients, providers, promotions };
}
