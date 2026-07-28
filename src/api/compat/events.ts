// DELETE IN P12
/**
 * `/events` — five endpoints that all mean "run whatever playbook wants this".
 *
 * Mounted twice: at `/events` and at `/api/events`. providers-service'
 * `communication-service-client.ts` posts to `/api/events` with a base URL that
 * defaults to the gateway, so the `/api` prefix survives the gateway's strip.
 * The plan flags this as "a bug to preserve/fix"; both mounts are the fix that
 * costs nothing.
 *
 * The three POST variants — `/legacy`, `/process`, `/` — reached three
 * different code paths in the source (`eventHandler`, `enhancedEventHandler`,
 * and the BullMQ subscriber). Only one of those did anything a caller could
 * observe. All three now run the playbook runtime; the difference that survives
 * is synchronous (`/process`) versus queued (`/`, `/legacy`), which is the only
 * distinction any caller could actually have depended on.
 */
import { randomUUID } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { PlaybookApiDeps } from '../v1/playbooks.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';
import { deprecate } from './index.js';
import { fromLegacyChannel } from './translate.js';
import type { CompatIdentity } from './translate.js';

const eventSchema = z.object({
  id: z.string().optional(),
  eventId: z.string().optional(),
  type: z.string().min(1),
  patientId: z.string().optional(),
  providerId: z.string().optional(),
  medspaId: z.string().optional(),
  locationId: z.string().optional(),
  channels: z.array(z.string()).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type LegacyEvent = z.infer<typeof eventSchema>;

export interface EventCompatDeps {
  playbooks: PlaybookApiDeps;
  identity: CompatIdentity;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyEventRouter(deps: EventCompatDeps): Router {
  const router = Router();
  router.use(deprecate('/events', '/v1/outreach/trigger'));

  async function toTrigger(
    req: Request,
    event: LegacyEvent,
  ): Promise<Parameters<PlaybookApiDeps['runtime']['run']>[0]> {
    const scope = requireTenant(req);
    // `medspaId` in the body is ignored in favour of the scope: the header wins
    // over the body for tenancy, everywhere, for the same reason the MCP router
    // does it (a body-supplied tenant is a cross-tenant send waiting to happen).
    const channels = (event.channels ?? [])
      .map(fromLegacyChannel)
      .filter((c): c is (typeof CHANNEL_TYPES)[number] =>
        (CHANNEL_TYPES as readonly string[]).includes(c),
      );

    return {
      type: 'event' as const,
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      eventType: event.type,
      payload: { context: event.data ?? {}, ...(event.metadata ? { metadata: event.metadata } : {}) },
      correlationId: event.id ?? event.eventId ?? randomUUID(),
      // The caller's own event id is the redelivery guard, so a retried POST
      // produces one run rather than a second send.
      idempotencyKey: event.id ?? event.eventId,
      ...(channels.length ? { channels } : {}),
      priority: event.priority,
      recipientId: event.patientId
        ? ((await deps.identity.lookup(scope, event.patientId)) ?? undefined)
        : undefined,
      senderId: event.providerId,
    };
  }

  const runOne = handle(async (req, res) => {
    const event = eventSchema.parse(req.body);
    const results = await deps.playbooks.runtime.run(await toTrigger(req, event));

    res.json({
      success: true,
      message: results.length
        ? 'Event processed successfully'
        : // The source says "Failed to process event" when the switch fell
          // through to `default:` — indistinguishable from a real failure, and
          // the reason 27 of its 44 event types went unnoticed for so long.
          'Event accepted; no playbook matched',
      matched: results.length,
      results,
    });
  });

  router.post('/legacy', runOne);
  router.post('/process', runOne);
  router.post('/', runOne);

  router.post(
    '/batch',
    handle(async (req, res) => {
      if (!Array.isArray(req.body)) {
        throw new ValidationError('Request body must be an array of events');
      }
      const events = z.array(eventSchema).parse(req.body);

      // Per-event outcomes without aborting the batch — the one thing the
      // source's batch paths get right, preserved here and in bulk approvals.
      const results = [];
      for (const event of events) {
        try {
          results.push({
            eventId: event.id ?? event.eventId,
            success: true,
            results: await deps.playbooks.runtime.run(await toTrigger(req, event)),
          });
        } catch (error) {
          results.push({
            eventId: event.id ?? event.eventId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.json({
        success: results.every((r) => r.success),
        message: 'Batch event subscription processed successfully',
        results,
      });
    }),
  );

  router.get(
    '/:eventId/status',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const runs = await deps.playbooks.runtime.findRuns(scope, req.params.eventId as string);
      if (runs.length === 0) throw new NotFoundError('Event not found');
      res.json({ success: true, status: runs[0]!.status, metadata: { runs } });
    }),
  );

  return router;
}
