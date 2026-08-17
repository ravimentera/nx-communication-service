/**
 * The MCP surface tera-orchestrator talks to.
 *
 * Two behaviours it depends on, both preserved:
 *
 *  1. **`GET /mcp/tools` is reachable without gateway headers.** The
 *     orchestrator calls it at its own startup, before any user is involved,
 *     to build its tool registry. Discovery is schema-only — it names the tools
 *     and their inputs and touches no tenant data — so it is mounted pre-auth
 *     alongside `/metrics`.
 *
 *  2. **The header wins over the body for tenancy.** `mcp/index.ts:70-80`
 *     carries a comment documenting a real cross-tenant send: the router used
 *     to fill `medspaId` from the body when the header was absent, so a forged
 *     body value could send email or SMS to another tenant's patients. Header
 *     always overrides, and this file does not regress it — it goes further and
 *     never reads a tenant from the body at all.
 *
 * **Execution is not pre-auth.** Discovery being open does not make sending
 * open: every tool that touches data goes through `requireTenant`, which throws
 * when the request carries no identity. The split is deliberate and the tests
 * assert both halves.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { ApprovalService } from '../engine/approvals/approval.service.js';
import type { Actor } from '../engine/approvals/state-machine.js';
import type { CampaignOrchestrator } from '../engine/campaigns/orchestrator.js';
import type { Dispatcher } from '../engine/delivery/dispatcher.js';
import type { TenantScope } from '../platform/db/tenant-scope.js';
import type { NotificationQueue } from '../engine/delivery/notification-queue.js';
import type { ConversationService } from '../engine/messaging/conversation.service.js';
import type { DraftService } from '../engine/outreach/draft.service.js';
import { requireTenant } from '../platform/http/auth.middleware.js';
import {
  AuthError,
  NotFoundError,
  NotImplementedError,
  ValidationError,
} from '../platform/http/errors.js';
import { toChannelType } from '../ports/channel.js';
import { MCP_MUTATION_TOOL_NAMES, MCP_TOOLS, MCP_TOOL_NAMES } from './tools.js';

export const MCP_SERVER = { name: 'outreach-server', version: '1.0.0' };

export interface McpDeps {
  dispatcher: Dispatcher;
  queue: NotificationQueue;
  logger: Logger;
  /**
   * The same auth middleware the rest of the app uses, applied to the
   * **executing** routes only.
   *
   * The whole router is mounted pre-auth so discovery works without headers,
   * which means `req.identity` is not resolved by the time a tool call
   * arrives. Rather than mounting the router twice — the source's approach,
   * which leaves the pre-auth copy executing tools by reading headers directly
   * — the split lives here, in one file, where it can be read.
   */
  authenticate: RequestHandler;
  /** Renders a template id/key to a body. Shared with the compat send routers. */
  render: (
    scope: TenantScope,
    input: { templateId?: string; variables?: Record<string, unknown>; message?: string; subject?: string },
  ) => Promise<{ subject?: string; body: string; html?: string; templateId?: string }>;

  /**
   * P12 workstream 5. Optional as a group: a deployment that wires only the
   * send tools keeps working, and the five review tools answer 501 naming what
   * is missing rather than throwing something opaque.
   *
   * They are advertised on discovery either way, deliberately. The tool list is
   * the service's contract and it should not change shape depending on how a
   * particular process was constructed — an orchestrator that discovered eleven
   * tools yesterday and seven today has no way to tell a deployment difference
   * from an outage.
   */
  drafts?: DraftService;
  approvals?: ApprovalService;
  conversations?: ConversationService;
  campaigns?: CampaignOrchestrator;
}

/** The external system a medspa-pack recipient is keyed by, as in the compat shim. */
const MEDSPA_RECIPIENT_SYSTEM = 'mentera-patient';

/** A tool that is advertised but whose service this process did not wire. */
function wired<T>(service: T | undefined, tool: string, what: string): T {
  if (!service) {
    throw new NotImplementedError(
      `MCP tool '${tool}' needs the ${what}, which this deployment did not wire`,
    );
  }
  return service;
}

const sendEmailSchema = z.object({
  to: z.string().min(1),
  subject: z.string().optional(),
  message: z.string().optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  providerId: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

const sendSmsSchema = sendEmailSchema.extend({ to: z.string().min(1) });

const slackSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  blocks: z.array(z.unknown()).optional(),
});

const alertSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  channel: z.string().optional(),
});

const enqueueSchema = z.object({
  type: z.enum(['EMAIL', 'SMS', 'SLACK', 'PUSH', 'WEBHOOK', 'IN_APP']),
  payload: z.record(z.string(), z.unknown()),
  metadata: z
    .object({
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      scheduledFor: z.string().optional(),
    })
    .optional(),
});

// ── P12 workstream 5 ────────────────────────────────────────────────────────

const draftSchema = z
  .object({
    patientId: z.string().min(1).optional(),
    recipientId: z.string().uuid().optional(),
    channel: z.string().min(1),
    goal: z.string().optional(),
    promptPackKey: z.string().min(1).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    providerId: z.string().optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  })
  .refine((v) => Boolean(v.patientId) !== Boolean(v.recipientId), {
    message: 'Exactly one of patientId or recipientId is required',
  });

const pendingSchema = z.object({
  approverRef: z.string().optional(),
  channel: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
});

const approveSchema = z.object({
  approvalId: z.string().uuid(),
  content: z.string().min(1).optional(),
  subject: z.string().optional(),
});

const conversationsSchema = z.object({
  providerId: z.string().optional(),
  search: z.string().optional(),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  playbookKey: z.string().min(1),
  audienceId: z.string().uuid(),
  providerId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The acting identity, for the tools that decide something.
 *
 * Tera forwards `x-user-id` and `x-user-role` per request from its own
 * `SessionContext`. Without them there is no actor, and an approval recorded
 * against nobody is worse than one that did not happen — `ApprovalService`
 * writes `decided_by` into an immutable audit trail.
 */
function actorOf(req: Request): Actor {
  const identity = req.identity;
  if (!identity) throw new AuthError();
  return {
    type: 'user',
    ref: identity.userId,
    senderId: identity.senderId,
    role: identity.role,
    permissions: identity.permissions,
  };
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createMcpRouter(deps: McpDeps): Router {
  const router = Router();

  async function callTool(req: Request, toolName: string, args: Record<string, unknown>) {
    // The tenant comes from the resolved identity, never from `args`. The
    // source strips a body-supplied `medspaId`; here there is nothing to strip,
    // because no tool schema declares one.
    const scope = requireTenant(req);

    switch (toolName) {
      case 'sendEmail': {
        const input = sendEmailSchema.parse(args);
        const rendered = await deps.render(scope, input);
        return deps.dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: 'email',
          to: { type: 'email', value: input.to },
          rendered: { subject: rendered.subject ?? input.subject, body: rendered.body, html: rendered.html },
          templateId: rendered.templateId,
          senderId: input.providerId ?? req.identity?.senderId,
          priority: input.priority,
        });
      }

      case 'sendSMS': {
        const input = sendSmsSchema.parse(args);
        const rendered = await deps.render(scope, input);
        return deps.dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: 'sms',
          to: { type: 'phone', value: input.to },
          rendered: { body: rendered.body },
          templateId: rendered.templateId,
          senderId: input.providerId ?? req.identity?.senderId,
          priority: input.priority,
        });
      }

      case 'sendSlackMessage': {
        const input = slackSchema.parse(args);
        return deps.dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: 'slack',
          to: { type: 'slack', value: input.channel },
          rendered: {
            body: input.text,
            ...(input.blocks ? { metadata: { blocks: input.blocks } } : {}),
          },
          transactional: true,
        });
      }

      case 'sendUrgentSlackAlert': {
        const input = alertSchema.parse(args);
        if (!input.channel) {
          // The source falls back to the literal `urgent-alerts`
          // (`slack.service.ts:109`) — one channel shared by every tenant (D55).
          throw new ValidationError(
            'channel is required, or configure slackDefaultChannel for this tenant',
          );
        }
        return deps.dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: 'slack',
          to: { type: 'slack', value: input.channel },
          rendered: { body: `*${input.title}*\n${input.message}`, subject: input.title },
          priority: 'URGENT',
          transactional: true,
        });
      }

      // ── P12 workstream 5 ──────────────────────────────────────────────────

      case 'generateDraft': {
        const input = draftSchema.parse(args);
        const channel = toChannelType(input.channel);
        if (!channel) throw new ValidationError(`Unknown channel '${input.channel}'`);

        const drafts = wired(deps.drafts, toolName, 'content plane');
        return drafts.draft(scope, {
          channel,
          ...(input.recipientId
            ? { recipientId: input.recipientId }
            : { externalRef: { system: MEDSPA_RECIPIENT_SYSTEM, id: input.patientId! } }),
          senderId: input.providerId ?? req.identity?.senderId,
          promptPackKey: input.promptPackKey,
          goal: input.goal,
          context: input.context,
          priority: input.priority,
        });
      }

      case 'listPendingApprovals': {
        const input = pendingSchema.parse(args);
        const approvals = wired(deps.approvals, toolName, 'approvals plane');

        // Same rule as `GET /v1/approvals/pending`: the queue read is the
        // caller's own unless they hold the permission to widen it. Tera runs
        // as a user, not as an admin, so this is a real constraint rather than
        // a formality.
        const approverRef =
          input.approverRef ?? req.identity?.senderId ?? req.identity?.userId;
        if (
          input.approverRef &&
          input.approverRef !== req.identity?.senderId &&
          input.approverRef !== req.identity?.userId &&
          !req.identity?.permissions?.includes('outreach:approve') &&
          !req.identity?.permissions?.includes('outreach:admin')
        ) {
          throw new ValidationError(
            "You may only read your own approval queue; 'outreach:approve' is required to read another's",
          );
        }

        return approvals.listPending(scope, {
          approverRef,
          channel: input.channel,
          priority: input.priority,
          page: input.page,
          pageSize: input.pageSize,
        });
      }

      case 'approveMessage': {
        const input = approveSchema.parse(args);
        const approvals = wired(deps.approvals, toolName, 'approvals plane');
        const actor = actorOf(req);

        // Authorization is per row inside the service — the approver check, the
        // policy's rights, the sender ownership. Nothing here re-implements it.
        return input.content
          ? approvals.editThenApprove(scope, input.approvalId, actor, input.content, input.subject)
          : approvals.approve(scope, input.approvalId, actor);
      }

      case 'listConversations': {
        const input = conversationsSchema.parse(args);
        const conversations = wired(deps.conversations, toolName, 'messaging plane');

        const senderId = input.providerId ?? req.identity?.senderId;
        if (!senderId) {
          throw new ValidationError(
            'providerId is required when the request carries no sender identity',
          );
        }

        return conversations.inbox(scope, senderId, {
          page: input.page,
          limit: input.limit,
          search: input.search,
        });
      }

      case 'createCampaign': {
        const input = campaignSchema.parse(args);
        const campaigns = wired(deps.campaigns, toolName, 'campaigns plane');

        // DRAFT, and it stays that way. `launch` is deliberately not a tool:
        // "start sending to this audience" is not something to reach by
        // conversation, and the confirmation an orchestrator shows is a
        // sentence, not a recipient count.
        const created = await campaigns.create(scope, {
          name: input.name,
          description: input.description,
          playbookKey: input.playbookKey,
          audienceId: input.audienceId,
          senderId: input.providerId ?? req.identity?.senderId,
          context: input.context,
        });

        return {
          ...created,
          status: 'DRAFT',
          note: 'Created as a draft. Launch it from the campaigns screen or POST /v1/campaigns/:id/launch.',
        };
      }

      case 'getQueueStatus':
        return { stats: await deps.queue.stats() };

      case 'addNotificationToQueue': {
        const input = enqueueSchema.parse(args);
        const payload = input.payload as { to?: string; message?: string; subject?: string };
        if (!payload.to || !payload.message) {
          throw new ValidationError('payload.to and payload.message are required');
        }
        return deps.dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: input.type.toLowerCase() as Parameters<Dispatcher['dispatch']>[0]['channel'],
          to: { type: input.type === 'SMS' ? 'phone' : input.type.toLowerCase(), value: payload.to },
          rendered: { subject: payload.subject, body: payload.message },
          priority: input.metadata?.priority ?? 'MEDIUM',
          sendAt: input.metadata?.scheduledFor ? new Date(input.metadata.scheduledFor) : undefined,
        });
      }

      case 'clearFailedJobs':
        // The source's queue service has no such method — the HTTP endpoint
        // that claims to do this probes for one, misses, and reports success
        // anyway. BullMQ's own `removeOnFail` retention handles it, so this
        // reports the truth rather than pretending.
        return {
          cleared: 0,
          note: 'Failed jobs expire on the queue retention policy (7d); no manual sweep is needed.',
        };

      default:
        throw new NotFoundError(`Unknown MCP tool '${toolName}'`);
    }
  }

  /**
   * Discovery. **Pre-auth** — mounted before the auth middleware in `app.ts`.
   * Schema only: no tenant data is read and no tool is executed.
   */
  router.get('/tools', (_req, res) => {
    res.json({
      success: true,
      tools: MCP_TOOLS,
      count: MCP_TOOLS.length,
      // Which of them a caller should confirm before running. Published because
      // the orchestrator's private copy of this list drifted off the tool names
      // and stopped gating two of them (D102). Each tool also carries
      // `mutation` inline, so a consumer can read it either way.
      mutationTools: MCP_MUTATION_TOOL_NAMES,
      server: { ...MCP_SERVER, tools: MCP_TOOL_NAMES },
    });
  });

  router.get('/health', (_req, res) => {
    res.json({
      success: true,
      status: 'healthy',
      server: MCP_SERVER.name,
      version: MCP_SERVER.version,
      toolCount: MCP_TOOLS.length,
      timestamp: new Date().toISOString(),
    });
  });

  router.post(
    '/tools/:toolName',
    deps.authenticate,
    handle(async (req, res) => {
      const toolName = req.params.toolName as string;
      const args = { ...(req.body ?? {}) } as Record<string, unknown>;

      // Kept as a warning rather than a rejection: the orchestrator has sent
      // `medspaId` historically, and failing the call would break it. The value
      // is discarded either way.
      if (args.medspaId || args.tenantId) {
        deps.logger.warn('MCP tool call carried a tenant in its body; ignoring it', {
          toolName,
          bodyTenant: args.medspaId ?? args.tenantId,
          identityTenant: req.identity?.tenantId,
        });
        delete args.medspaId;
        delete args.tenantId;
      }

      const result = await callTool(req, toolName, args);
      res.json({ success: true, toolName, result });
    }),
  );

  /**
   * The Bedrock Agent shim. Legacy and dormant — no Bedrock Agents are in the
   * current invocation path — but it stays routable, so it gets the same tenant
   * guarantee as its sibling rather than being left as an open twin.
   */
  router.post(
    '/bedrock',
    deps.authenticate,
    handle(async (req, res) => {
      const { actionGroup, function: functionName, parameters } = (req.body ?? {}) as {
        actionGroup?: string;
        function?: string;
        parameters?: Record<string, unknown>;
      };
      const toolName = actionGroup ?? functionName;
      if (!toolName) throw new ValidationError('actionGroup or function is required');

      const args = { ...(parameters ?? {}) };
      delete args.medspaId;
      delete args.tenantId;

      const result = await callTool(req, toolName, args);
      res.json({
        response: {
          actionGroup: actionGroup ?? toolName,
          function: functionName ?? toolName,
          functionResponse: { responseBody: result },
        },
        success: true,
      });
    }),
  );

  return router;
}
