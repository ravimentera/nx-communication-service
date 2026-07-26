/**
 * The policy engine: given a draft and a policy row, decide whether a human
 * looks at it and — if so — which human.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 *
 * Nothing. There is no policy in the source: `ai-message-generator.ts:258`
 * writes `approvalStatus: 'PENDING_APPROVAL'` unconditionally and the approver
 * is whatever `providerId` happens to be on the row. "Every AI message waits for
 * the provider who owns the patient" is the only policy the system can express,
 * and it is expressed by hardcoding it in four places.
 *
 * That policy is preserved exactly as `{mode: 'always', approver: {kind:'agent'}}`,
 * which is what the medspa pack ships. The other three modes are new capability,
 * not new behaviour for anyone who does not opt in.
 *
 * THRESHOLD MODE IS HARD-DISABLED
 *
 * `threshold` auto-approves above a confidence bar. `aiConfidence` is a
 * heuristic — context completeness minus a lint penalty (D35) — not a calibrated
 * probability, and the model's own self-assessment is deliberately ignored when
 * computing it. Letting a heuristic decide that no human reviews a clinical
 * message is a decision a tenant must make explicitly, so the mode refuses to
 * fire unless `tenant_packs.config.allowAutoApprove` is true for that tenant.
 * A policy row set to `threshold` without the flag falls back to review, loudly.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';

import { and, eq, isNull, or } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { approvalPolicies, tenantPacks } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';

export const APPROVER_KINDS = ['agent', 'role', 'group', 'round_robin'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

export type ApproverResolution =
  | { kind: 'agent'; fallbackApproverRef?: string }
  | { kind: 'role'; role: string }
  | { kind: 'group'; ids: string[]; semantics?: 'any_of' | 'all_of' }
  | { kind: 'round_robin'; ids: string[] };

export interface ApprovalRights {
  approve?: boolean;
  edit?: boolean;
  decline?: boolean;
  reschedule?: boolean;
  bulk?: boolean;
}

export interface ApprovalSla {
  deadlineMs?: number;
  onExpiry?: 'escalate' | 'decline' | 'approve';
  fallbackApproverRef?: string;
}

export interface ApprovalPolicy {
  id: string;
  tenantId: string | null;
  packId: string | null;
  key: string;
  name: string;
  mode: 'always' | 'threshold' | 'sample' | 'none';
  confidenceThreshold: number | null;
  sampleRate: number | null;
  approverResolution: ApproverResolution;
  rights: ApprovalRights;
  sla: ApprovalSla;
}

/** The parts of a draft the policy actually looks at. */
export interface PolicyDraft {
  /** Stable id the `sample` mode hashes. The message id, once one exists. */
  messageId: string;
  aiConfidence?: number | null;
  lintErrors?: number;
  senderId?: string | null;
  playbookId?: string | null;
}

export type ApprovalDecision =
  | { kind: 'auto'; reason: 'mode_none' | 'threshold_met' | 'sample_skip' }
  | {
      kind: 'review';
      approverType: ApproverKind;
      approverRef: string;
      /** Only set for `group`; `all_of` needs every member to decide. */
      semantics?: 'any_of' | 'all_of';
      slaDeadline?: Date;
    };

/**
 * A stable counter, one per `(tenantId, playbookId)`. Redis-backed in
 * production; the in-memory fallback (P1/D10) makes the rotation per-replica
 * rather than global, which for round-robin means slightly uneven spread and
 * nothing worse — it is a fairness heuristic, not a correctness property.
 */
export interface RotationCounter {
  next(key: string): Promise<number>;
}

/**
 * Resolves a role name to the users holding it. A stub in P6: it reads
 * `tenant_packs.config.roleMembers[role]`. P12 replaces it with the real
 * authorization service.
 */
export interface AuthorizationProvider {
  membersOf(scope: TenantScope, role: string): Promise<string[]>;
}

export interface PolicyServiceDeps {
  db: Db;
  logger: Logger;
  rotation: RotationCounter;
  authorization?: AuthorizationProvider;
}

/**
 * Deterministic in [0, 1) from a message id.
 *
 * `Math.random()` would make `sample` mode unreproducible: the same message
 * replayed after a queue retry could take a different path, and no test could
 * assert the mode at all. sha256 truncated to 32 bits is stable across
 * processes, replicas and restarts.
 */
export function sampleBucket(messageId: string): number {
  const digest = createHash('sha256').update(messageId).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export class PolicyService {
  constructor(private readonly deps: PolicyServiceDeps) {}

  /**
   * Load a policy. A row with `tenant_id = NULL` is the pack-provided default;
   * a tenant's own row with the same key overrides it (D19's convention, shared
   * with `prompt_packs`). The tenant row wins because it is sorted first.
   */
  async load(
    scope: TenantScope,
    ref: { policyId?: string | null; key?: string | null },
  ): Promise<ApprovalPolicy | null> {
    if (ref.policyId) {
      const [row] = await this.deps.db
        .select()
        .from(approvalPolicies)
        .where(
          and(
            eq(approvalPolicies.id, ref.policyId),
            // A tenant may only reference its own policies or a shared default.
            or(eq(approvalPolicies.tenantId, scope.tenantId), isNull(approvalPolicies.tenantId)),
          ),
        )
        .limit(1);
      return row ? toPolicy(row) : null;
    }

    if (!ref.key) return null;

    const rows = await this.deps.db
      .select()
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.key, ref.key),
          or(eq(approvalPolicies.tenantId, scope.tenantId), isNull(approvalPolicies.tenantId)),
        ),
      );

    // Tenant-specific first, pack default second.
    const chosen = rows.find((r) => r.tenantId === scope.tenantId) ?? rows[0];
    return chosen ? toPolicy(chosen) : null;
  }

  /** Everything this tenant can reference: its own rows plus the pack defaults. */
  async list(scope: TenantScope): Promise<ApprovalPolicy[]> {
    const rows = await this.deps.db
      .select()
      .from(approvalPolicies)
      .where(or(eq(approvalPolicies.tenantId, scope.tenantId), isNull(approvalPolicies.tenantId)));
    return rows.map(toPolicy);
  }

  async create(scope: TenantScope, input: PolicyInput): Promise<ApprovalPolicy> {
    const [row] = await this.deps.db
      .insert(approvalPolicies)
      .values({
        // Always the caller's tenant. A tenant cannot author a NULL-tenant row
        // over the API — pack defaults arrive through a migration or the pack
        // loader, never from a request.
        tenantId: scope.tenantId,
        packId: input.packId ?? null,
        key: input.key,
        name: input.name,
        mode: input.mode,
        confidenceThreshold: numericOrNull(input.confidenceThreshold),
        sampleRate: numericOrNull(input.sampleRate),
        approverResolution: input.approverResolution ?? { kind: 'agent' },
        rights: input.rights ?? {},
        sla: input.sla ?? {},
      })
      .returning();

    if (!row) throw new Error('failed to create the approval policy');
    return toPolicy(row);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: Partial<PolicyInput>,
  ): Promise<ApprovalPolicy> {
    const [row] = await this.deps.db
      .update(approvalPolicies)
      .set({
        ...(patch.key === undefined ? {} : { key: patch.key }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.mode === undefined ? {} : { mode: patch.mode }),
        ...(patch.packId === undefined ? {} : { packId: patch.packId }),
        ...(patch.confidenceThreshold === undefined
          ? {}
          : { confidenceThreshold: numericOrNull(patch.confidenceThreshold) }),
        ...(patch.sampleRate === undefined ? {} : { sampleRate: numericOrNull(patch.sampleRate) }),
        ...(patch.approverResolution === undefined
          ? {}
          : { approverResolution: patch.approverResolution }),
        ...(patch.rights === undefined ? {} : { rights: patch.rights }),
        ...(patch.sla === undefined ? {} : { sla: patch.sla }),
        updatedAt: new Date(),
      })
      // A pack default (tenant_id NULL) is shared by every tenant that installed
      // the pack, so no single tenant may edit it — the predicate excludes it.
      .where(and(eq(approvalPolicies.id, id), eq(approvalPolicies.tenantId, scope.tenantId)))
      .returning();

    if (!row) {
      throw new NotFoundError(
        `Approval policy '${id}' not found for this tenant. Pack-provided defaults cannot be edited; create a tenant policy with the same key to override one.`,
      );
    }
    return toPolicy(row);
  }

  async decide(input: {
    policy: ApprovalPolicy;
    draft: PolicyDraft;
    scope: TenantScope;
  }): Promise<ApprovalDecision> {
    const { policy, draft, scope } = input;

    switch (policy.mode) {
      case 'none':
        return { kind: 'auto', reason: 'mode_none' };

      case 'threshold': {
        if (await this.autoApproveAllowed(scope)) {
          const bar = policy.confidenceThreshold;
          const confidence = draft.aiConfidence ?? 0;
          const lintClean = (draft.lintErrors ?? 0) === 0;
          // Both conditions, not either: a confident draft that trips a
          // compliance lint rule is exactly the one a human should see.
          if (bar !== null && confidence >= bar && lintClean) {
            return { kind: 'auto', reason: 'threshold_met' };
          }
        } else {
          this.deps.logger.warn(
            'policy requests threshold auto-approval but the tenant has not opted in — falling back to review',
            { tenantId: scope.tenantId, policyKey: policy.key },
          );
        }
        break;
      }

      case 'sample': {
        const rate = policy.sampleRate;
        // rate is the fraction REVIEWED. rate=0.1 means one in ten is read by a
        // human and nine in ten skip straight through.
        if (rate !== null && sampleBucket(draft.messageId) >= rate) {
          return { kind: 'auto', reason: 'sample_skip' };
        }
        break;
      }

      case 'always':
        break;
    }

    return this.resolveApprover(policy, draft, scope);
  }

  /**
   * `tenant_packs.config.allowAutoApprove` on any installed, active pack.
   * Absent means false — the tenant has to say yes, not forget to say no.
   */
  private async autoApproveAllowed(scope: TenantScope): Promise<boolean> {
    const rows = await this.deps.db
      .select({ config: tenantPacks.config })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.isActive, true)));

    return rows.some(
      (row) => (row.config as { allowAutoApprove?: unknown } | null)?.allowAutoApprove === true,
    );
  }

  private async resolveApprover(
    policy: ApprovalPolicy,
    draft: PolicyDraft,
    scope: TenantScope,
  ): Promise<ApprovalDecision> {
    const resolution = policy.approverResolution;
    const slaDeadline = policy.sla.deadlineMs
      ? new Date(Date.now() + policy.sla.deadlineMs)
      : undefined;

    switch (resolution.kind) {
      case 'agent': {
        // Today's behaviour: the provider who owns the message approves it.
        const ref = draft.senderId ?? resolution.fallbackApproverRef ?? policy.sla.fallbackApproverRef;
        if (!ref) {
          throw new ValidationError(
            'Policy resolves the approver to the message sender, but the message has no senderId and the policy declares no fallbackApproverRef',
            { policyKey: policy.key },
          );
        }
        return { kind: 'review', approverType: 'agent', approverRef: ref, slaDeadline };
      }

      case 'role': {
        const members = this.deps.authorization
          ? await this.deps.authorization.membersOf(scope, resolution.role)
          : [];
        // The ref stays the ROLE, not a resolved member: membership changes
        // between assignment and decision, and the inbox should follow the role.
        // Members are resolved at authorization time instead.
        this.deps.logger.debug('approval assigned to role', {
          role: resolution.role,
          members: members.length,
        });
        return { kind: 'review', approverType: 'role', approverRef: resolution.role, slaDeadline };
      }

      case 'group': {
        if (resolution.ids.length === 0) {
          throw new ValidationError('Group approver resolution declares no ids', {
            policyKey: policy.key,
          });
        }
        return {
          kind: 'review',
          approverType: 'group',
          // Stored as a stable, sorted, comma-joined key so the same group
          // always produces the same approver_ref regardless of authoring order.
          approverRef: [...resolution.ids].sort().join(','),
          semantics: resolution.semantics ?? 'any_of',
          slaDeadline,
        };
      }

      case 'round_robin': {
        if (resolution.ids.length === 0) {
          throw new ValidationError('Round-robin approver resolution declares no ids', {
            policyKey: policy.key,
          });
        }
        const key = `approvals:rr:${scope.tenantId}:${draft.playbookId ?? policy.key}`;
        const n = await this.deps.rotation.next(key);
        const ids = [...resolution.ids].sort();
        return {
          kind: 'review',
          approverType: 'round_robin',
          approverRef: ids[n % ids.length] as string,
          slaDeadline,
        };
      }
    }
  }
}

/** What the API may author. `tenantId` is never one of them — see `create`. */
export interface PolicyInput {
  key: string;
  name: string;
  mode: ApprovalPolicy['mode'];
  confidenceThreshold?: number | null;
  sampleRate?: number | null;
  approverResolution?: ApproverResolution | { kind: ApproverKind };
  rights?: ApprovalRights;
  sla?: ApprovalSla;
  packId?: string | null;
}

/** Drizzle wants `numeric` as a string; undefined must not become "undefined". */
function numericOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

type PolicyRow = typeof approvalPolicies.$inferSelect;

/**
 * `numeric` comes back from pg as a string to preserve precision; the JSONB
 * columns come back as `unknown`. One place converts both, so nothing
 * downstream has to remember that `confidence_threshold` is not a number yet.
 */
function toPolicy(row: PolicyRow): ApprovalPolicy {
  return {
    id: row.id,
    tenantId: row.tenantId,
    packId: row.packId,
    key: row.key,
    name: row.name,
    mode: row.mode as ApprovalPolicy['mode'],
    confidenceThreshold: row.confidenceThreshold === null ? null : Number(row.confidenceThreshold),
    sampleRate: row.sampleRate === null ? null : Number(row.sampleRate),
    approverResolution: (row.approverResolution as ApproverResolution) ?? { kind: 'agent' },
    rights: (row.rights as ApprovalRights) ?? {},
    sla: (row.sla as ApprovalSla) ?? {},
  };
}

/**
 * The policy used when a caller submits a draft for approval without naming
 * one. Deliberately `always`: a message that reached `submit()` was believed to
 * need review, and the failure mode of guessing wrong here is either "a human
 * reads something they need not have" or "nobody reads a clinical message". The
 * first is cheap.
 */
export const FALLBACK_POLICY: ApprovalPolicy = {
  id: '00000000-0000-0000-0000-000000000000',
  tenantId: null,
  packId: null,
  key: 'system.review-everything',
  name: 'Fallback — review everything',
  mode: 'always',
  confidenceThreshold: null,
  sampleRate: null,
  approverResolution: { kind: 'agent' },
  rights: { approve: true, edit: true, decline: true, reschedule: true, bulk: false },
  sla: {},
};
