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
import { NotFoundError } from '../../platform/http/errors.js';
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
  // `/leads`, `/treatments`, `/patients`, `/providers`, `/promotions` and its
  // `/gift-cards` alias were retired in P12 (D100): nothing calls any of them.
  // They answer 410 naming their successor — see RETIRED_MOUNTS in index.ts.
  //
  // `/ehr-webhook` survives for a different reason: an EHR vendor posts to it
  // from its own configuration, which no grep over this repo can see.
  return { ehrWebhook };
}
