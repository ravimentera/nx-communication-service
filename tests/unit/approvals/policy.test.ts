/**
 * The policy engine, with the database stubbed to the two things `decide()`
 * actually reads: the tenant's installed packs (for the auto-approve opt-in)
 * and nothing else.
 */
import winston from 'winston';

import {
  FALLBACK_POLICY,
  PolicyService,
  sampleBucket,
  type ApprovalPolicy,
  type RotationCounter,
} from '../../../src/engine/approvals/policy.service.js';
import type { Db } from '../../../src/db/index.js';

const logger = winston.createLogger({ silent: true });
const scope = { tenantId: 't-1' };

/**
 * `decide()` touches the database in exactly one place — `autoApproveAllowed`,
 * which selects `tenant_packs.config`. Stubbing that one chain keeps the test on
 * the decision logic instead of on Postgres.
 */
function dbWithPackConfig(configs: Record<string, unknown>[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => configs.map((config) => ({ config })),
      }),
    }),
  } as unknown as Db;
}

function counter(start = 0): RotationCounter {
  let n = start;
  return { next: async () => ++n };
}

function service(
  configs: Record<string, unknown>[] = [],
  rotation: RotationCounter = counter(),
): PolicyService {
  return new PolicyService({ db: dbWithPackConfig(configs), logger, rotation });
}

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  ...FALLBACK_POLICY,
  id: 'pol-1',
  key: 'test.policy',
  ...over,
});

const draft = (over: Partial<Parameters<PolicyService['decide']>[0]['draft']> = {}) => ({
  messageId: '11111111-1111-1111-1111-111111111111',
  senderId: 'p-1',
  ...over,
});

describe('mode: none', () => {
  it('auto-approves without touching the approver', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({ mode: 'none' }),
      draft: draft({ senderId: null }),
    });
    expect(decision).toEqual({ kind: 'auto', reason: 'mode_none' });
  });
});

describe('mode: always', () => {
  it('always reviews, however confident the draft is', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({ mode: 'always' }),
      draft: draft({ aiConfidence: 1 }),
    });
    expect(decision).toMatchObject({ kind: 'review', approverType: 'agent', approverRef: 'p-1' });
  });
});

describe('mode: threshold', () => {
  const thresholdPolicy = policy({ mode: 'threshold', confidenceThreshold: 0.8 });

  it('refuses to auto-approve without the tenant opt-in, even at confidence 1.0', async () => {
    // The whole reason threshold mode ships disabled: aiConfidence is a
    // heuristic (D35), not a calibrated probability, and letting it decide that
    // nobody reads a clinical message must be an explicit tenant choice.
    const decision = await service([]).decide({
      scope,
      policy: thresholdPolicy,
      draft: draft({ aiConfidence: 1, lintErrors: 0 }),
    });
    expect(decision.kind).toBe('review');
  });

  it('is not enabled by some other pack config key', async () => {
    const decision = await service([{ someOtherFlag: true }]).decide({
      scope,
      policy: thresholdPolicy,
      draft: draft({ aiConfidence: 1, lintErrors: 0 }),
    });
    expect(decision.kind).toBe('review');
  });

  it('auto-approves once the tenant has opted in and the bar is met', async () => {
    const decision = await service([{ allowAutoApprove: true }]).decide({
      scope,
      policy: thresholdPolicy,
      draft: draft({ aiConfidence: 0.85, lintErrors: 0 }),
    });
    expect(decision).toEqual({ kind: 'auto', reason: 'threshold_met' });
  });

  it('reviews below the bar', async () => {
    const decision = await service([{ allowAutoApprove: true }]).decide({
      scope,
      policy: thresholdPolicy,
      draft: draft({ aiConfidence: 0.79, lintErrors: 0 }),
    });
    expect(decision.kind).toBe('review');
  });

  it('reviews a confident draft that trips a lint rule', async () => {
    // Both conditions, not either. A high-confidence draft that fails a
    // compliance rule is exactly the one a human should see.
    const decision = await service([{ allowAutoApprove: true }]).decide({
      scope,
      policy: thresholdPolicy,
      draft: draft({ aiConfidence: 0.99, lintErrors: 1 }),
    });
    expect(decision.kind).toBe('review');
  });

  it('reviews when the policy declares no threshold at all', async () => {
    const decision = await service([{ allowAutoApprove: true }]).decide({
      scope,
      policy: policy({ mode: 'threshold', confidenceThreshold: null }),
      draft: draft({ aiConfidence: 1 }),
    });
    expect(decision.kind).toBe('review');
  });
});

describe('mode: sample', () => {
  it('is deterministic for a fixed messageId', async () => {
    // Determinism is the requirement, not a nicety: a message replayed after a
    // queue retry must take the same path, and Math.random() could not be
    // asserted at all.
    const svc = service();
    const runs = await Promise.all(
      Array.from({ length: 20 }, () =>
        svc.decide({
          scope,
          policy: policy({ mode: 'sample', sampleRate: 0.5 }),
          draft: draft(),
        }),
      ),
    );
    const kinds = new Set(runs.map((r) => r.kind));
    expect(kinds.size).toBe(1);
  });

  it('reviews everything at rate 1 and nothing at rate 0', async () => {
    const svc = service();
    const ids = Array.from({ length: 25 }, (_, i) => `msg-${i}`);

    for (const messageId of ids) {
      const all = await svc.decide({
        scope,
        policy: policy({ mode: 'sample', sampleRate: 1 }),
        draft: draft({ messageId }),
      });
      const none = await svc.decide({
        scope,
        policy: policy({ mode: 'sample', sampleRate: 0 }),
        draft: draft({ messageId }),
      });
      expect(all.kind).toBe('review');
      expect(none).toEqual({ kind: 'auto', reason: 'sample_skip' });
    }
  });

  it('spreads roughly evenly across ids', async () => {
    const buckets = Array.from({ length: 2000 }, (_, i) => sampleBucket(`m-${i}`));
    const reviewed = buckets.filter((b) => b < 0.25).length;
    // 25% of 2000 = 500. A hash that clumped would fail this wide band.
    expect(reviewed).toBeGreaterThan(420);
    expect(reviewed).toBeLessThan(580);
    expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...buckets)).toBeLessThan(1);
  });
});

describe('approver resolution', () => {
  it('agent resolves to the message sender — today’s behaviour', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({ approverResolution: { kind: 'agent' } }),
      draft: draft({ senderId: 'provider-42' }),
    });
    expect(decision).toMatchObject({ approverType: 'agent', approverRef: 'provider-42' });
  });

  it('agent falls back when the message has no sender', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({
        approverResolution: { kind: 'agent', fallbackApproverRef: 'clinic-manager' },
      }),
      draft: draft({ senderId: null }),
    });
    expect(decision).toMatchObject({ approverRef: 'clinic-manager' });
  });

  it('agent throws rather than guessing when there is no sender and no fallback', async () => {
    await expect(
      service().decide({
        scope,
        policy: policy({ approverResolution: { kind: 'agent' } }),
        draft: draft({ senderId: null }),
      }),
    ).rejects.toThrow(/no senderId/);
  });

  it('role keeps the role as the ref, so the inbox follows membership changes', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({ approverResolution: { kind: 'role', role: 'clinical-lead' } }),
      draft: draft(),
    });
    expect(decision).toMatchObject({ approverType: 'role', approverRef: 'clinical-lead' });
  });

  it('group produces a stable ref regardless of authoring order', async () => {
    const a = await service().decide({
      scope,
      policy: policy({ approverResolution: { kind: 'group', ids: ['c', 'a', 'b'] } }),
      draft: draft(),
    });
    const b = await service().decide({
      scope,
      policy: policy({ approverResolution: { kind: 'group', ids: ['b', 'c', 'a'] } }),
      draft: draft(),
    });
    expect(a).toMatchObject({ approverType: 'group', approverRef: 'a,b,c', semantics: 'any_of' });
    expect(b).toMatchObject({ approverRef: 'a,b,c' });
  });

  it('group carries all_of through when the policy asks for it', async () => {
    const decision = await service().decide({
      scope,
      policy: policy({
        approverResolution: { kind: 'group', ids: ['a', 'b'], semantics: 'all_of' },
      }),
      draft: draft(),
    });
    expect(decision).toMatchObject({ semantics: 'all_of' });
  });

  it('round_robin rotates', async () => {
    const svc = service([], counter());
    const refs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const decision = await svc.decide({
        scope,
        policy: policy({ approverResolution: { kind: 'round_robin', ids: ['x', 'y', 'z'] } }),
        draft: draft(),
      });
      if (decision.kind === 'review') refs.push(decision.approverRef);
    }
    expect(refs).toEqual(['y', 'z', 'x', 'y', 'z', 'x']);
  });

  it('rejects an empty group or rotation rather than assigning to nobody', async () => {
    for (const resolution of [
      { kind: 'group' as const, ids: [] },
      { kind: 'round_robin' as const, ids: [] },
    ]) {
      await expect(
        service().decide({ scope, policy: policy({ approverResolution: resolution }), draft: draft() }),
      ).rejects.toThrow(/no ids/);
    }
  });
});

describe('SLA deadline', () => {
  it('is set from the policy when it declares one', async () => {
    const before = Date.now();
    const decision = await service().decide({
      scope,
      policy: policy({ sla: { deadlineMs: 3_600_000, onExpiry: 'escalate' } }),
      draft: draft(),
    });
    if (decision.kind !== 'review') throw new Error('expected review');
    expect(decision.slaDeadline!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('is absent when the policy declares none — nothing expires by default', async () => {
    const decision = await service().decide({ scope, policy: policy(), draft: draft() });
    if (decision.kind !== 'review') throw new Error('expected review');
    expect(decision.slaDeadline).toBeUndefined();
  });
});

describe('the fallback policy', () => {
  it('reviews everything', () => {
    // Guessing wrong here either makes a human read something they need not
    // have, or sends a clinical message nobody read. Only one of those is cheap.
    expect(FALLBACK_POLICY.mode).toBe('always');
    expect(FALLBACK_POLICY.rights.bulk).toBe(false);
  });
});
