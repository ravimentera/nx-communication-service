/**
 * The inbox, against a real Postgres.
 *
 * The point of this suite is the number of **SQL statements** one page costs —
 * not the number of conversations it returns. The handler this replaces issues
 * `3 + 3N` statements for a page of N conversations, so the default page size
 * of 50 costs 153 round trips to render one screen. The replacement is a
 * grouped CTE with two laterals plus one count: **2 statements, whether the
 * page holds one conversation or two hundred.**
 *
 * That shape is only worth its complexity if it actually holds, and a statement
 * counter on the pool is the only way to assert it. It is also what stops
 * someone reintroducing a per-row lookup later without noticing.
 *
 * It doubles as the syntax check on the raw SQL: none of it is expressible in
 * the Drizzle query builder, so a typo would otherwise surface at runtime.
 *
 * (Testcontainers, not a real database — see the header of schema.test.ts.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import { messageAnalytics, messages, recipients } from '../../src/db/schema.js';
import { ConversationService } from '../../src/engine/messaging/conversation.service.js';
import { MessageService } from '../../src/engine/messaging/message.service.js';

const logger = winston.createLogger({ silent: true });
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000a2';
const SENDER = 'sender-1';
const scope = { tenantId: TENANT };

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let conversations: ConversationService;
let messageService: MessageService;

/** Wraps the pool so a test can count the statements a call actually issues. */
let statements: string[] = [];

async function makeRecipient(displayName: string, tenantId = TENANT): Promise<string> {
  const [row] = await db
    .insert(recipients)
    .values({
      tenantId,
      externalRef: { system: 'test', id: `${displayName}-${Math.random().toString(36).slice(2)}` },
      displayName,
    })
    .returning({ id: recipients.id });
  return row!.id;
}

async function makeMessage(over: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      tenantId: TENANT,
      senderId: SENDER,
      channel: 'EMAIL',
      content: 'hello',
      status: 'SENT',
      direction: 'outbound',
      sentAt: new Date(),
      ...over,
    } as typeof messages.$inferInsert)
    .returning({ id: messages.id });
  return row!.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(
    `INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Inbox','UTC'), ('${OTHER_TENANT}','Other','UTC')`,
  );
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;

  const realQuery = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
    if (text) statements.push(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realQuery as any)(...args);
  };

  conversations = new ConversationService({ db, logger });
  messageService = new MessageService({ db, logger });
}, 240_000);

beforeEach(async () => {
  statements = [];
  await db.delete(messageAnalytics);
  await db.delete(messages);
  await db.delete(recipients);
  statements = [];
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

describe('inbox', () => {
  it('costs two SQL statements for a page of twelve conversations', async () => {
    for (let i = 0; i < 12; i += 1) {
      const recipientId = await makeRecipient(`Person ${i}`);
      await makeMessage({ recipientId, sentAt: new Date(Date.now() - i * 60_000) });
      await makeMessage({ recipientId, content: 'second', sentAt: new Date(Date.now() - i * 1000) });
    }
    statements = [];

    const page = await conversations.inbox(scope, SENDER, { limit: 12 });

    expect(page.conversations).toHaveLength(12);
    expect(page.total).toBe(12);
    // Two SQL statements for twelve conversations and 24 messages. The handler
    // this replaces would have issued 3 + 3×12 = 39 for the same page.
    expect(statements).toHaveLength(2);
  });

  it('excludes QUEUED and DECLINED drafts from every count and from the latest message', async () => {
    const recipientId = await makeRecipient('Ada');
    await makeMessage({ recipientId, content: 'real', sentAt: new Date(Date.now() - 10_000) });
    await makeMessage({ recipientId, content: 'draft', status: 'QUEUED', sentAt: new Date() });
    await makeMessage({ recipientId, content: 'nope', status: 'DECLINED', sentAt: new Date() });

    const page = await conversations.inbox(scope, SENDER);

    expect(page.total).toBe(1);
    expect(page.conversations[0]!.messageStats.totalMessages).toBe(1);
    expect(page.conversations[0]!.latestMessage?.content).toBe('real');
  });

  it('does not throw when the sender has no messages', async () => {
    // The source guards an `IN ()` here (:1237); a missing guard 500s the whole
    // screen for any provider with an empty inbox.
    const page = await conversations.inbox(scope, 'nobody');
    expect(page).toMatchObject({ conversations: [], total: 0, totalPages: 0 });
  });

  it('counts only inbound unread messages', async () => {
    const recipientId = await makeRecipient('Ada');
    await makeMessage({ recipientId, direction: 'inbound', readAt: null });
    await makeMessage({ recipientId, direction: 'inbound', readAt: null });
    await makeMessage({ recipientId, direction: 'inbound', readAt: new Date() });
    await makeMessage({ recipientId, direction: 'outbound', readAt: null });

    const [conversation] = (await conversations.inbox(scope, SENDER)).conversations;

    expect(conversation!.messageStats.unreadCount).toBe(2);
    expect(conversation!.messageStats.totalMessages).toBe(4);
    expect(conversation!.hasUnread).toBe(true);
  });

  it('searches across the recipient name and the message body', async () => {
    const ada = await makeRecipient('Ada Lovelace');
    const grace = await makeRecipient('Grace Hopper');
    await makeMessage({ recipientId: ada, content: 'about the engine' });
    await makeMessage({ recipientId: grace, content: 'about the compiler' });

    const byName = await conversations.inbox(scope, SENDER, { search: 'lovelace' });
    expect(byName.conversations.map((c) => c.displayName)).toEqual(['Ada Lovelace']);

    const byBody = await conversations.inbox(scope, SENDER, { search: 'compiler' });
    expect(byBody.conversations.map((c) => c.displayName)).toEqual(['Grace Hopper']);

    // The count query has to carry the same predicate, or pagination lies.
    expect(byBody.total).toBe(1);
  });

  it('sorts by latest activity and paginates', async () => {
    const old = await makeRecipient('Old');
    const recent = await makeRecipient('Recent');
    await makeMessage({ recipientId: old, sentAt: new Date('2026-01-01T00:00:00Z') });
    await makeMessage({ recipientId: recent, sentAt: new Date('2026-06-01T00:00:00Z') });

    const first = await conversations.inbox(scope, SENDER, { limit: 1, page: 1 });
    const second = await conversations.inbox(scope, SENDER, { limit: 1, page: 2 });

    expect(first.conversations[0]!.displayName).toBe('Recent');
    expect(second.conversations[0]!.displayName).toBe('Old');
    expect(first.totalPages).toBe(2);
  });

  it('reads alerts off message_analytics.metadata', async () => {
    // patient_feedback is a ghost table (D11) — empty, tenant-blind, absent from
    // the source's migrations. Its concepts live here now (§0.7).
    const recipientId = await makeRecipient('Ada');
    const messageId = await makeMessage({ recipientId });
    await db.insert(messageAnalytics).values({
      tenantId: TENANT,
      messageId,
      recipientId,
      metadata: { isAdverse: true, requiresFollowup: true, resolved: false },
    });

    const [conversation] = (await conversations.inbox(scope, SENDER)).conversations;
    expect(conversation!.alerts).toEqual({ hasAdverse: true, requiresFollowup: true });
  });

  it('reports no alerts when nothing has been analysed', async () => {
    const recipientId = await makeRecipient('Ada');
    await makeMessage({ recipientId });

    const [conversation] = (await conversations.inbox(scope, SENDER)).conversations;
    expect(conversation!.alerts).toEqual({ hasAdverse: false, requiresFollowup: false });
  });

  it('never returns another tenant’s conversations', async () => {
    const mine = await makeRecipient('Mine');
    await makeMessage({ recipientId: mine });
    const theirs = await makeRecipient('Theirs', OTHER_TENANT);
    await db.insert(messages).values({
      tenantId: OTHER_TENANT,
      senderId: SENDER,
      recipientId: theirs,
      channel: 'EMAIL',
      content: 'not yours',
      status: 'SENT',
      sentAt: new Date(),
    });

    const page = await conversations.inbox(scope, SENDER);
    expect(page.total).toBe(1);
    expect(page.conversations[0]!.displayName).toBe('Mine');
  });
});

describe('thread', () => {
  it('costs three SQL statements: the message page, the roll-up and the name', async () => {
    const recipientId = await makeRecipient('Ada Lovelace');
    await makeMessage({ recipientId, content: 'first', sentAt: new Date('2026-01-01T00:00:00Z') });
    await makeMessage({
      recipientId,
      content: 'reply',
      direction: 'inbound',
      sentAt: new Date('2026-01-02T00:00:00Z'),
    });
    await makeMessage({ recipientId, content: 'draft', status: 'QUEUED' });
    statements = [];

    const thread = await conversations.thread(scope, SENDER, recipientId);

    // Three statements, and three regardless of how many messages the thread
    // holds — the source issues four and then one more per conversation.
    expect(statements).toHaveLength(3);
    expect(thread.displayName).toBe('Ada Lovelace');
    // Most recent first, for the chat UI.
    expect(thread.messages.map((m) => m.content)).toEqual(['reply', 'first']);
    expect(thread.summary).toMatchObject({
      totalMessages: 2,
      unreadCount: 1,
      // Structurally zero: the same query excludes status = 'QUEUED'.
      queuedCount: 0,
      pendingApprovalCount: 0,
    });
  });
});

describe('read state', () => {
  it('marking an already-read message read succeeds instead of 404ing', async () => {
    const recipientId = await makeRecipient('Ada');
    const messageId = await makeMessage({ recipientId, readAt: new Date() });

    const result = await messageService.markRead(scope, messageId);
    expect(result.isRead).toBe(true);
  });

  it('404s on a message belonging to another tenant', async () => {
    const theirs = await makeRecipient('Theirs', OTHER_TENANT);
    const [row] = await db
      .insert(messages)
      .values({
        tenantId: OTHER_TENANT,
        senderId: SENDER,
        recipientId: theirs,
        channel: 'EMAIL',
        content: 'not yours',
        status: 'SENT',
        readAt: new Date(),
      })
      .returning({ id: messages.id });

    // The source answers 200 with the other tenant's row here: its existence
    // check at :1745 carries no tenant predicate.
    await expect(messageService.markRead(scope, row!.id)).rejects.toThrow(/not found/i);
  });

  it('marks only unread inbound messages when reading a whole conversation', async () => {
    const recipientId = await makeRecipient('Ada');
    await makeMessage({ recipientId, direction: 'inbound', readAt: null });
    await makeMessage({ recipientId, direction: 'inbound', readAt: null });
    await makeMessage({ recipientId, direction: 'outbound', readAt: null });

    const result = await messageService.markConversationRead(scope, SENDER, recipientId);
    expect(result.messagesMarkedRead).toBe(2);
  });
});
