/**
 * The inbox and the conversation thread — the FE's main screen, and the
 * highest-risk single handler in the extraction.
 *
 * `communications.controller.ts:getProviderInbox` (:1181-1390) issues **3 + 3N
 * SQL statements** to render one page — not rows, statements — where N is the
 * number of conversations on that page. The plan estimated 3 + 2N; on top of
 * the latest message and the stats roll-up there is a third per-conversation
 * query against `patient_feedback` (:1306). At the default page size of 50
 * that is **153 round trips to the database for one screen**.
 *
 * This issues **two SQL statements**, whatever the page size — a page of 200
 * conversations costs the same two as a page of one: a grouped CTE with a
 * lateral for the latest message and a lateral for the alerts, plus one count.
 * Step 2 of the source — the raw `SELECT ... FROM patients` at :1238 —
 * disappears entirely, because after P5 `recipients.display_name` holds the
 * name (Seam C).
 *
 * Behaviour preserved exactly, including the parts that look like accidents:
 *  - `status NOT IN ('QUEUED','DECLINED')` (:1197-1201) — queued and declined
 *    drafts must not surface in the inbox.
 *  - the empty-id guard (:1237). Here it is structural: nothing is interpolated
 *    from a list, so the `IN ()` shape that 500s cannot occur.
 *  - search over display name OR content (:1206).
 *  - sort by latest `sent_at` desc.
 *  - `summary` totals computed from **the current page**, not the whole result
 *    set (:1373-1375). Counting across all conversations would be more useful
 *    and would change every number the FE renders.
 *
 * One substitution, forced by §0.10: alerts came from `patient_feedback`, which
 * is a ghost table — absent from the source's own migrations, tenant-blind, and
 * empty in production (D11). Its concepts live on `message_analytics.metadata`
 * now (§0.7). Empty metadata yields `false`/`0`, which is what the source
 * returns today from an empty table, so the visible answer is unchanged.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';

/** Rows in these states are drafts, not correspondence. */
const HIDDEN_STATUSES = ['QUEUED', 'DECLINED'] as const;

export interface ConversationSummaryRow {
  recipientId: string | null;
  displayName: string | null;
  latestMessage: {
    id: string;
    content: string;
    sentAt: Date | null;
    channel: string;
    status: string;
    direction: string;
    messageType: string;
    isAiGenerated: boolean;
  } | null;
  messageStats: {
    totalMessages: number;
    unreadCount: number;
    lastActivity: Date | null;
  };
  hasUnread: boolean;
  alerts: { hasAdverse: boolean; requiresFollowup: boolean };
}

export interface InboxPage {
  conversations: ConversationSummaryRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ThreadMessage {
  id: string;
  content: string;
  channel: string;
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  direction: string;
  aiGenerated: boolean;
  metadata: Record<string, unknown> | null;
  eventType: string | null;
  engagementScore: number | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

export interface Thread {
  senderId: string;
  recipientId: string;
  displayName: string | null;
  messages: ThreadMessage[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  summary: {
    totalMessages: number;
    unreadCount: number;
    firstMessage: Date | null;
    lastMessage: Date | null;
    aiGeneratedCount: number;
    queuedCount: number;
    pendingApprovalCount: number;
  };
}

export interface ConversationServiceDeps {
  db: Db;
  logger: Logger;
}

/** Tenant predicate for raw SQL, where `tenantWhere` cannot be used. */
function scopePredicate(scope: TenantScope, alias: string): SQL {
  const base = sql.raw(`${alias}.tenant_id = `);
  return scope.subTenantId
    ? sql`${base}${scope.tenantId} AND ${sql.raw(`${alias}.sub_tenant_id`)} = ${scope.subTenantId}`
    : sql`${base}${scope.tenantId}`;
}

function hiddenPredicate(alias: string): SQL {
  return sql`${sql.raw(`${alias}.status`)} NOT IN (${sql.join(
    HIDDEN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;
}

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  /**
   * One conversation per recipient for a given sender, most recently active
   * first.
   *
   * **Two SQL statements, independent of page size** — the page and the count.
   * Not two conversations: a page returns up to `limit` of them.
   */
  async inbox(
    scope: TenantScope,
    senderId: string,
    opts: { page?: number; limit?: number; search?: string } = {},
  ): Promise<InboxPage> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const offset = (page - 1) * limit;

    const base = sql`
      FROM messages m
      LEFT JOIN recipients r ON r.id = m.recipient_id
      WHERE ${scopePredicate(scope, 'm')}
        AND m.sender_id = ${senderId}
        AND ${hiddenPredicate('m')}
    `;
    // Search spans the recipient's name and the message body, exactly as the
    // source does over `metadata->>'patientName'` OR `content` (:1206). The
    // name moved to `recipients` in P5; the metadata copy is no longer the
    // authority.
    const filtered = opts.search
      ? sql`${base} AND (r.display_name ILIKE ${`%${opts.search}%`} OR m.content ILIKE ${`%${opts.search}%`})`
      : base;

    const pageQuery = sql`
      WITH conv AS (
        SELECT m.recipient_id                                            AS recipient_id,
               MAX(m.sent_at)                                            AS last_activity,
               COUNT(*)::int                                             AS total_messages,
               COUNT(*) FILTER (
                 WHERE m.read_at IS NULL AND m.direction = 'inbound'
               )::int                                                    AS unread_count
        ${filtered}
        GROUP BY m.recipient_id
        ORDER BY MAX(m.sent_at) DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      )
      SELECT conv.recipient_id                                           AS "recipientId",
             conv.last_activity                                          AS "lastActivity",
             conv.total_messages                                         AS "totalMessages",
             conv.unread_count                                           AS "unreadCount",
             r.display_name                                              AS "displayName",
             latest.id                                                   AS "latestId",
             latest.content                                              AS "latestContent",
             latest.sent_at                                              AS "latestSentAt",
             latest.channel                                              AS "latestChannel",
             latest.status                                               AS "latestStatus",
             latest.direction                                            AS "latestDirection",
             latest.metadata ->> 'messageType'                           AS "latestMessageType",
             latest.ai_generated                                         AS "latestAiGenerated",
             COALESCE(alerts.has_adverse, false)                         AS "hasAdverse",
             COALESCE(alerts.requires_followup, false)                   AS "requiresFollowup"
      FROM conv
      LEFT JOIN recipients r ON r.id = conv.recipient_id
      LEFT JOIN LATERAL (
        SELECT m2.id, m2.content, m2.sent_at, m2.channel, m2.status,
               m2.direction, m2.metadata, m2.ai_generated
        FROM messages m2
        WHERE ${scopePredicate(scope, 'm2')}
          AND m2.sender_id = ${senderId}
          AND m2.recipient_id IS NOT DISTINCT FROM conv.recipient_id
          AND ${hiddenPredicate('m2')}
        ORDER BY m2.sent_at DESC NULLS LAST
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT bool_or(COALESCE((a.metadata ->> 'isAdverse')::boolean, false))  AS has_adverse,
               bool_or(
                 COALESCE((a.metadata ->> 'requiresFollowup')::boolean, false)
                 AND NOT COALESCE((a.metadata ->> 'resolved')::boolean, false)
               )                                                                AS requires_followup
        FROM message_analytics a
        WHERE ${scopePredicate(scope, 'a')}
          AND a.recipient_id IS NOT DISTINCT FROM conv.recipient_id
          AND a.created_at >= now() - INTERVAL '7 days'
      ) alerts ON true
      ORDER BY conv.last_activity DESC NULLS LAST
    `;

    const countQuery = sql`
      SELECT COUNT(DISTINCT m.recipient_id)::int AS "total"
      ${filtered}
    `;

    const [pageResult, countResult] = await Promise.all([
      this.deps.db.execute(pageQuery),
      this.deps.db.execute(countQuery),
    ]);

    const total = Number((countResult.rows[0] as { total?: number } | undefined)?.total ?? 0);

    const conversations = (pageResult.rows as Record<string, unknown>[]).map((row) => {
      const unreadCount = Number(row.unreadCount ?? 0);
      return {
        recipientId: (row.recipientId as string | null) ?? null,
        displayName: (row.displayName as string | null) ?? null,
        latestMessage: row.latestId
          ? {
              id: row.latestId as string,
              content: (row.latestContent as string | null) ?? '',
              sentAt: (row.latestSentAt as Date | null) ?? null,
              channel: row.latestChannel as string,
              status: row.latestStatus as string,
              direction: (row.latestDirection as string | null) ?? 'outbound',
              messageType: (row.latestMessageType as string | null) ?? 'GENERAL',
              isAiGenerated: Boolean(row.latestAiGenerated),
            }
          : null,
        messageStats: {
          totalMessages: Number(row.totalMessages ?? 0),
          unreadCount,
          lastActivity: (row.lastActivity as Date | null) ?? null,
        },
        hasUnread: unreadCount > 0,
        alerts: {
          hasAdverse: Boolean(row.hasAdverse),
          requiresFollowup: Boolean(row.requiresFollowup),
        },
      } satisfies ConversationSummaryRow;
    });

    this.deps.logger.debug('inbox page', {
      tenantId: scope.tenantId,
      senderId,
      conversations: conversations.length,
      total,
      page,
    });

    return {
      conversations,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * The full thread between one sender and one recipient.
   *
   * **Three SQL statements**, independent of how many messages the thread
   * holds: the message page, the roll-up, and the recipient's name.
   *
   * `queuedCount` and `pendingApprovalCount` are in the source's summary
   * (:1526-1527) and are structurally always zero, because the same query
   * excludes `status = 'QUEUED'` two lines earlier (:1413). They are reported
   * here for shape compatibility and carry the same value they always did.
   */
  async thread(
    scope: TenantScope,
    senderId: string,
    recipientId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<Thread> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const offset = (page - 1) * limit;

    const where = sql`
      WHERE ${scopePredicate(scope, 'm')}
        AND m.sender_id = ${senderId}
        AND m.recipient_id = ${recipientId}
        AND ${hiddenPredicate('m')}
    `;

    const [messagesResult, summaryResult, recipientResult] = await Promise.all([
      this.deps.db.execute(sql`
        SELECT m.id, m.content, m.channel, m.status, m.sent_at AS "sentAt",
               m.delivered_at AS "deliveredAt", m.read_at AS "readAt",
               m.created_at AS "createdAt", m.direction,
               m.ai_generated AS "aiGenerated", m.metadata,
               e.type AS "eventType",
               a.engagement_score AS "engagementScore",
               a.opened_at AS "openedAt",
               a.clicked_at AS "clickedAt",
               a.replied_at AS "repliedAt"
        FROM messages m
        LEFT JOIN outreach_events e ON e.id = m.event_id
        LEFT JOIN message_analytics a ON a.message_id = m.id
        ${where}
        ORDER BY m.sent_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `),
      this.deps.db.execute(sql`
        SELECT COUNT(*)::int                                                AS "totalMessages",
               COUNT(*) FILTER (
                 WHERE m.read_at IS NULL AND m.direction = 'inbound'
               )::int                                                       AS "unreadCount",
               MIN(m.sent_at)                                               AS "firstMessage",
               MAX(m.sent_at)                                               AS "lastMessage",
               COUNT(*) FILTER (WHERE m.ai_generated)::int                   AS "aiGeneratedCount",
               COUNT(*) FILTER (WHERE m.status = 'QUEUED')::int              AS "queuedCount",
               -- Reads approvals.status, where approval state has lived since
               -- P6. It used to read queued_message->>'approvalStatus' -- a
               -- column this engine has never written, so the predicate could
               -- only ever have matched a migrated row. Dropped with the
               -- column in P12 (D103).
               --
               -- The m.status = 'QUEUED' term STAYS, and keeps this
               -- structurally zero exactly as the docblock above says.
               -- Dropping it would change a number the front end renders,
               -- inside a commit whose job was removing a dead column. If this
               -- count should start being real, that is its own change with
               -- its own entry in BREAKING.md.
               COUNT(*) FILTER (
                 WHERE m.status = 'QUEUED' AND ap.status = 'PENDING_APPROVAL'
               )::int                                                       AS "pendingApprovalCount"
        FROM messages m
        -- At most one approval per message: approvals.message_id is UNIQUE
        -- (0002), so this join cannot multiply the counts above.
        LEFT JOIN approvals ap ON ap.message_id = m.id AND ap.tenant_id = m.tenant_id
        ${where}
      `),
      this.deps.db.execute(sql`
        SELECT r.display_name AS "displayName"
        FROM recipients r
        WHERE r.id = ${recipientId} AND ${scopePredicate(scope, 'r')}
        LIMIT 1
      `),
    ]);

    const s = (summaryResult.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(s.totalMessages ?? 0);

    return {
      senderId,
      recipientId,
      displayName:
        ((recipientResult.rows[0] as { displayName?: string } | undefined)?.displayName ?? null),
      messages: (messagesResult.rows as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        content: (row.content as string | null) ?? '',
        channel: row.channel as string,
        status: row.status as string,
        sentAt: (row.sentAt as Date | null) ?? null,
        deliveredAt: (row.deliveredAt as Date | null) ?? null,
        readAt: (row.readAt as Date | null) ?? null,
        createdAt: row.createdAt as Date,
        direction: (row.direction as string | null) ?? 'outbound',
        aiGenerated: Boolean(row.aiGenerated),
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        eventType: (row.eventType as string | null) ?? null,
        engagementScore: (row.engagementScore as number | null) ?? null,
        openedAt: (row.openedAt as Date | null) ?? null,
        clickedAt: (row.clickedAt as Date | null) ?? null,
        repliedAt: (row.repliedAt as Date | null) ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      summary: {
        totalMessages: total,
        unreadCount: Number(s.unreadCount ?? 0),
        firstMessage: (s.firstMessage as Date | null) ?? null,
        lastMessage: (s.lastMessage as Date | null) ?? null,
        aiGeneratedCount: Number(s.aiGeneratedCount ?? 0),
        queuedCount: Number(s.queuedCount ?? 0),
        pendingApprovalCount: Number(s.pendingApprovalCount ?? 0),
      },
    };
  }
}
