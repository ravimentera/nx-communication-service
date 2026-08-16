/**
 * `/v1/campaigns` and `/v1/audiences`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAUNCH RETURNS BEFORE THE CAMPAIGN FINISHES, AND THAT IS THE DESIGN
 *
 * `POST /v1/campaigns/:id/launch` expands the audience, records every recipient
 * as PENDING, starts the run loop and answers 202 with the count. It does not
 * wait: a 10,000-recipient campaign is minutes of model calls, and an HTTP
 * request that waits for it is a request that times out behind a proxy while
 * the work carries on invisibly.
 *
 * That is exactly what the source did —
 * `ai-enhanced-communication.controller.ts:batchGenerateCommunications` loops
 * over every patient inside the request — and it is why a batch there has no
 * status anyone can query. Here the state is in the database before the
 * response is written, so `GET /v1/campaigns/:id/stats` is the answer to
 * "how is it going?" from the first millisecond.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IMPORT ROUTE TAKES JSON ROWS, NOT A FILE
 *
 * `AudienceService.importRows` consumes an async iterable and never holds more
 * than a batch in memory, because a lead list is the one input to this engine
 * routinely larger than memory. This route feeds it from a JSON array, which is
 * bounded by `express.json`'s body limit and therefore NOT the large-list path.
 *
 * Multipart CSV upload belongs with the storage adapter in P12 (workstream 3b):
 * both need somewhere to put a file that is not this process's heap. Until then
 * the streaming import is reachable from code and from tests, and this route
 * serves the paste-a-few-hundred-rows case honestly rather than pretending to
 * be the bulk path.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { AudienceService, ImportRow } from '../../engine/campaigns/audience.service.js';
import { CONSENT_SOURCES } from '../../engine/compliance/consent.service.js';
import type { CampaignOrchestrator } from '../../engine/campaigns/orchestrator.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const audienceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['static', 'query', 'accumulating']).optional(),
  definition: z
    .object({
      where: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
});

const membersSchema = z.object({
  recipientIds: z.array(z.string().uuid()).min(1),
  source: z.string().optional(),
});

const importRowSchema = z.object({
  externalId: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `rows` is validated per row by the service, not here: a 500-row import with
 * one bad address must import 499 and report the one, which a whole-body Zod
 * parse cannot express. This schema only checks the envelope.
 */
const importSchema = z.object({
  system: z.string().min(1).optional(),
  rows: z.array(z.unknown()).min(1),
  /**
   * The lawful basis for contacting this list, if the caller has one.
   *
   * Optional, and with no default. An imported audience with no consent is
   * unreachable once enforcement is on, which is the correct outcome for a list
   * whose provenance nobody can state — defaulting it would turn "we have a
   * spreadsheet" into a recorded claim that these people agreed.
   */
  consent: z
    .object({
      channels: z.array(z.enum(CHANNEL_TYPES)).min(1),
      source: z.enum(CONSENT_SOURCES),
      grantedAt: z.string().datetime().optional(),
      proof: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
  playbookKey: z.string().min(1),
  audienceId: z.string().uuid(),
  senderId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  schedule: z.object({ sendAt: z.string().optional() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface CampaignApiDeps {
  campaigns: CampaignOrchestrator;
  audiences: AudienceService;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createCampaignRouter(deps: CampaignApiDeps): Router {
  const router = Router();

  // ── audiences ─────────────────────────────────────────────────────────────

  router.get(
    '/audiences',
    handle(async (req, res) => {
      res.json({ data: await deps.audiences.list(requireTenant(req)) });
    }),
  );

  router.post(
    '/audiences',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = audienceSchema.parse(req.body);
      res.status(201).json(await deps.audiences.create(scope, body));
    }),
  );

  router.get(
    '/audiences/:id',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const audience = await deps.audiences.getById(scope, req.params.id as string);
      if (!audience) throw new NotFoundError(`Audience '${req.params.id}' not found`);
      res.json(audience);
    }),
  );

  router.post(
    '/audiences/:id/members',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = membersSchema.parse(req.body);
      res.json(
        await deps.audiences.addMembers(scope, req.params.id as string, body.recipientIds, body.source),
      );
    }),
  );

  router.delete(
    '/audiences/:id/members',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = membersSchema.parse(req.body);
      res.json(await deps.audiences.removeMembers(scope, req.params.id as string, body.recipientIds));
    }),
  );

  router.post(
    '/audiences/:id/import',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = importSchema.parse(req.body);

      // Coerced row by row, so a malformed one is reported with its line number
      // rather than failing the request. The service applies the real rules.
      async function* rows(): AsyncIterable<ImportRow> {
        for (const raw of body.rows) {
          const parsed = importRowSchema.safeParse(raw);
          yield parsed.success ? parsed.data : ({ externalId: '' } as ImportRow);
        }
      }

      const result = await deps.audiences.importRows(scope, req.params.id as string, rows(), {
        ...(body.system ? { system: body.system } : {}),
        ...(body.consent
          ? {
              consent: {
                channels: body.consent.channels,
                source: body.consent.source,
                ...(body.consent.grantedAt
                  ? { grantedAt: new Date(body.consent.grantedAt) }
                  : {}),
                ...(body.consent.proof ? { proof: body.consent.proof } : {}),
              },
            }
          : {}),
      });
      res.status(result.errors > 0 ? 207 : 200).json(result);
    }),
  );

  router.get(
    '/audiences/:id/import-errors',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json({
        data: await deps.audiences.listImportErrors(scope, req.params.id as string, {
          ...(req.query.importId ? { importId: req.query.importId as string } : {}),
          ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
          ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
        }),
      });
    }),
  );

  router.post(
    '/audiences/:id/materialize',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(await deps.audiences.materialize(scope, req.params.id as string));
    }),
  );

  // ── campaigns ─────────────────────────────────────────────────────────────

  router.get(
    '/campaigns',
    handle(async (req, res) => {
      res.json({ data: await deps.campaigns.list(requireTenant(req)) });
    }),
  );

  router.post(
    '/campaigns',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = campaignSchema.parse(req.body);
      res.status(201).json(await deps.campaigns.create(scope, body));
    }),
  );

  router.get(
    '/campaigns/:id',
    handle(async (req, res) => {
      res.json(await deps.campaigns.require(requireTenant(req), req.params.id as string));
    }),
  );

  router.get(
    '/campaigns/:id/stats',
    handle(async (req, res) => {
      res.json(await deps.campaigns.stats(requireTenant(req), req.params.id as string));
    }),
  );

  router.get(
    '/campaigns/:id/recipients',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json({
        data: await deps.campaigns.recipients(scope, req.params.id as string, {
          ...(req.query.status ? { status: req.query.status as string } : {}),
          ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
          ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
        }),
      });
    }),
  );

  // 202, not 200: the work outlives the request. See the header.
  router.post(
    '/campaigns/:id/launch',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const result = await deps.campaigns.launch(scope, req.params.id as string);
      res.status(202).json(result);
    }),
  );

  router.post(
    '/campaigns/:id/pause',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      await deps.campaigns.pause(scope, req.params.id as string);
      res.json({ status: 'PAUSED' });
    }),
  );

  router.post(
    '/campaigns/:id/resume',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      await deps.campaigns.resume(scope, req.params.id as string);
      res.status(202).json({ status: 'PROCESSING' });
    }),
  );

  /**
   * Stops generation, cancels every recipient not yet generated, and recalls
   * generated messages still waiting in the queue (P12; the delivery port had no
   * removal until then — D83).
   *
   * The response reports three numbers because they are three different
   * outcomes, and `alreadySending` is the one an operator needs: those messages
   * were with a worker when the cancel landed and may well have gone out. There
   * is no point at which a distributed queue can promise otherwise.
   */
  router.post(
    '/campaigns/:id/cancel',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const result = await deps.campaigns.cancel(scope, req.params.id as string);
      res.json({
        status: 'CANCELLED',
        ...result,
        note:
          result.alreadySending > 0
            ? `${result.alreadySending} message(s) were already being sent and could not be recalled.`
            : 'Nothing was in flight; every generated message still queued was recalled.',
      });
    }),
  );

  return router;
}
