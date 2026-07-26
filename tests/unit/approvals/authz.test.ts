/**
 * Per-row authorization.
 *
 * The rule being generalized is `approvals.controller.ts:65–71` — "you can only
 * view your own approvals" — which the source applies to the pending LIST and to
 * nothing else. Every mutation there (`approve` :325, `decline` :426, `edit`
 * :687, `edit-approve` :534, `schedule` :981, `bulk` :792) looks the row up by
 * bare message id, so provider A can approve provider B's message today, and a
 * user in tenant A can approve tenant B's. These tests pin the fix.
 */
import winston from 'winston';

import type { Db } from '../../../src/db/index.js';
import { ApprovalService } from '../../../src/engine/approvals/approval.service.js';
import { approvals as approvalsTable, messages } from '../../../src/db/schema.js';
import { FALLBACK_POLICY, type PolicyService } from '../../../src/engine/approvals/policy.service.js';
import type { Actor } from '../../../src/engine/approvals/state-machine.js';
import { ForbiddenError } from '../../../src/platform/http/errors.js';
import type { Dispatcher } from '../../../src/engine/delivery/dispatcher.js';

const logger = winston.createLogger({ silent: true });
const scope = { tenantId: 't-1' };

type Row = typeof approvalsTable.$inferSelect;

function approvalRow(over: Partial<Row> = {}): Row {
  return {
    id: 'a-1',
    tenantId: 't-1',
    subTenantId: null,
    playbookId: null,
    messageId: 'm-1',
    status: 'PENDING_APPROVAL',
    approverType: 'agent',
    approverRef: 'provider-A',
    requestedAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    slaDeadline: null,
    originalContent: 'hello',
    editedContent: null,
    declineReason: null,
    aiConfidence: null,
    policyId: null,
    auditTrail: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Row;
}

/**
 * A drizzle query builder is thenable *and* chainable — `await db.select()...
 * .where(x)` and `.where(x).limit(1)` are both valid. This returns one object
 * that is both, so the fake behaves like the real builder without dragging in
 * Postgres. The lifecycle itself is covered by the integration suite.
 */
function builder<T>(rows: T[], onResolve?: () => void) {
  const settle = () => {
    onResolve?.();
    return rows;
  };
  const self = {
    where: () => self,
    limit: () => self,
    orderBy: () => self,
    offset: () => self,
    returning: () => self,
    then: (ok: (v: T[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(ok, err),
  };
  return self;
}

function fakeDb(row: Row, seen: { updates: number } = { updates: 0 }): Db {
  const rowsFor = (table: unknown) => (table === messages ? [{ id: 'm-1', tenantId: 't-1' }] : [row]);
  return {
    select: () => ({ from: (table: unknown) => builder(rowsFor(table)) }),
    update: (table: unknown) => ({
      set: () => builder(rowsFor(table), () => (seen.updates += 1)),
    }),
  } as unknown as Db;
}

const policies = {
  load: async () => FALLBACK_POLICY,
} as unknown as PolicyService;

const dispatcher = {
  dispatch: async () => ({ queued: true, messageId: 'm-1', jobId: 'j-1' }),
} as unknown as Dispatcher;

function service(row: Row, seen?: { updates: number }): ApprovalService {
  return new ApprovalService({ db: fakeDb(row, seen), logger, policies, dispatcher });
}

const actor = (over: Partial<Actor> = {}): Actor => ({
  type: 'user',
  ref: 'user-a',
  senderId: 'provider-A',
  role: 'provider',
  permissions: [],
  ...over,
});

describe('approverType agent', () => {
  it('lets the assigned sender act', async () => {
    const seen = { updates: 0 };
    const result = await service(approvalRow(), seen).decline(scope, 'a-1', actor(), 'nope');
    expect(result.approval).toBeDefined();
    expect(seen.updates).toBeGreaterThan(0);
  });

  it('stops provider B approving provider A’s message', async () => {
    const svc = service(approvalRow({ approverRef: 'provider-A' }));
    const b = actor({ ref: 'user-b', senderId: 'provider-B' });

    await expect(svc.approve(scope, 'a-1', b)).rejects.toThrow(ForbiddenError);
    await expect(svc.decline(scope, 'a-1', b)).rejects.toThrow(ForbiddenError);
    await expect(svc.edit(scope, 'a-1', b, 'edited')).rejects.toThrow(ForbiddenError);
    await expect(svc.schedule(scope, 'a-1', b, new Date(Date.now() + 60_000))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(svc.cancel(scope, 'a-1', b)).rejects.toThrow(ForbiddenError);
  });

  it('stops a caller with no senderId at all', async () => {
    // A staff user with no agent identity has nothing to match against, and
    // "no sender" must not read as "matches everything".
    await expect(
      service(approvalRow()).approve(scope, 'a-1', actor({ senderId: undefined })),
    ).rejects.toThrow(ForbiddenError);
  });

  it('treats a null approverType the same as agent', async () => {
    await expect(
      service(approvalRow({ approverType: null, approverRef: 'provider-A' })).approve(
        scope,
        'a-1',
        actor({ senderId: 'provider-B' }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('lets an admin through, by role or by permission', async () => {
    const byRole = actor({ senderId: 'provider-B', role: 'admin' });
    const byPermission = actor({ senderId: 'provider-B', permissions: ['outreach:admin'] });

    await expect(service(approvalRow()).decline(scope, 'a-1', byRole)).resolves.toBeDefined();
    await expect(service(approvalRow()).decline(scope, 'a-1', byPermission)).resolves.toBeDefined();
  });
});

describe('approverType role and group', () => {
  it('requires outreach:approve', async () => {
    await expect(
      service(approvalRow({ approverType: 'role', approverRef: 'clinical-lead' })).decline(
        scope,
        'a-1',
        actor(),
      ),
    ).rejects.toThrow(/outreach:approve permission/);
  });

  it('admits the holder of outreach:approve', async () => {
    await expect(
      service(approvalRow({ approverType: 'role', approverRef: 'clinical-lead' })).decline(
        scope,
        'a-1',
        actor({ permissions: ['outreach:approve'] }),
      ),
    ).resolves.toBeDefined();
  });

  it('additionally requires group membership', async () => {
    const row = approvalRow({ approverType: 'group', approverRef: 'provider-A,provider-C' });
    const outsider = actor({ senderId: 'provider-Z', permissions: ['outreach:approve'] });
    const member = actor({ senderId: 'provider-C', permissions: ['outreach:approve'] });

    await expect(service(row).decline(scope, 'a-1', outsider)).rejects.toThrow(
      /not a member of this approval group/,
    );
    await expect(service(row).decline(scope, 'a-1', member)).resolves.toBeDefined();
  });
});

describe('bulk', () => {
  it('is refused without outreach:approve:bulk', async () => {
    await expect(
      service(approvalRow()).bulk(scope, ['a-1'], 'approve', actor()),
    ).rejects.toThrow(/outreach:approve:bulk/);
  });

  it('is allowed with the permission', async () => {
    // The fake echoes the fixture row back from the UPDATE, so the resulting
    // status says nothing here — what matters is that the action was permitted
    // and a write happened. The lifecycle is asserted in the integration suite.
    const seen = { updates: 0 };
    const result = await service(approvalRow(), seen).bulk(
      scope,
      ['a-1'],
      'decline',
      actor({ permissions: ['outreach:approve:bulk'] }),
      'batch',
    );
    expect(result.results).toEqual([expect.objectContaining({ id: 'a-1', ok: true })]);
    expect(seen.updates).toBeGreaterThan(0);
  });

  it('reports per-id outcomes instead of aborting the batch on the first failure', async () => {
    // Matches the source's behaviour at approvals.controller.ts:882, which is
    // the one thing that path gets right.
    const svc = service(approvalRow({ approverRef: 'someone-else' }));
    const result = await svc.bulk(
      scope,
      ['a-1', 'a-2'],
      'decline',
      actor({ permissions: ['outreach:approve:bulk'] }),
    );
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => !r.ok)).toBe(true);
    expect(result.results[0]!.error).toMatch(/only act on approvals assigned to you/);
  });

  it('refuses an empty or oversized batch', async () => {
    const svc = service(approvalRow());
    const admin = actor({ role: 'admin' });
    await expect(svc.bulk(scope, [], 'approve', admin)).rejects.toThrow(/must not be empty/);
    await expect(
      svc.bulk(scope, Array.from({ length: 501 }, (_, i) => `a-${i}`), 'approve', admin),
    ).rejects.toThrow(/limited to 500/);
  });
});
