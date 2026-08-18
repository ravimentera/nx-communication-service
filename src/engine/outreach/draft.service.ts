/**
 * Draft a message for a recipient and put it under approval.
 *
 * **This is the one capability that never had a `/v1` home.** Generating copy
 * lives at `POST /v1/content/generate`, which returns a draft and stores
 * nothing; submitting an existing draft lives at `/v1/approvals`. The thing the
 * front end and Tera both actually want — *generate, then queue it for a human*
 * — existed only inside the compat shim, as `draftFor` in
 * `api/compat/generation.ts`, reachable at `/communications/generate-message`
 * and `/automated-messages/generate`.
 *
 * That was invisible until two things collided:
 *
 *  - P12's compat trim (D100) retired `/ai-enhanced` and `/automated-messages`
 *    with a `410` naming **`POST /v1/outreach/generate`** as the successor — a
 *    route nobody had written. A 410 pointing at a 404 is worse than a 404.
 *  - Workstream 5 specifies `generateDraft` as an MCP tool "backed by v1", and
 *    there was no v1 to back it with.
 *
 * So the logic moves here, in engine vocabulary, and gets three callers: the new
 * `POST /v1/outreach/generate`, the MCP tool, and the compat shim — which now
 * only translates `patientId` → `recipientId` and delegates. See D101.
 *
 * ── THE POLICY IS LEFT UNNAMED, DELIBERATELY ─────────────────────────────────
 *
 * `submit` with no policy ref resolves to `FALLBACK_POLICY` — `always`, review
 * everything (`policy.service.ts:433`). Naming one instead would be worse in
 * both directions: a `none`-mode policy dispatches without writing an approval
 * row at all (D58), which on this path means Tera sending unreviewed model
 * output to a patient, and a key that does not resolve makes `submit` throw.
 *
 * So the default is *no key*, which is what the compat path has always passed,
 * and `policyKey` is an explicit opt-in for a caller that means it. Either way
 * the result reports the status actually reached, so an auto-approval is
 * visible rather than something to infer.
 */
import type { ApprovalService } from '../approvals/approval.service.js';
import type { ContentGenerator } from '../content/generator.js';
import type { IdentityResolver } from '../content/identity.js';
import type { RenderContext } from '../content/render-context.js';
import type { PackRegistry } from '../../packs/loader.js';
import type { RecipientService } from '../recipients/recipient.service.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import type { ChannelType, ContactPoint } from '../../ports/channel.js';

/** What the generator falls back to when the caller names no prompt pack. */
export const DEFAULT_DRAFT_PROMPT_PACK = 'core.content-generate';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface DraftRequest {
  channel: ChannelType;
  /**
   * The recipient, one way or the other. `recipientId` is an engine id;
   * `externalRef` is the vertical's own id (`{system: 'mentera-patient', id}`)
   * and is resolved through the installed context provider, creating the
   * recipient if this tenant has not seen them.
   */
  recipientId?: string;
  externalRef?: { system: string; id: string };
  senderId?: string;
  promptPackKey?: string;
  goal?: string;
  context?: Record<string, unknown>;
  priority?: Priority;
  overrides?: { tone?: string; language?: string; model?: string };
  /**
   * Review under a named policy instead of the review-everything fallback.
   * Read the header first: a `none`-mode key sends without a human.
   */
  policyKey?: string;
}

export interface DraftResult {
  approvalId?: string;
  messageId?: string;
  content: string;
  subject?: string;
  /** The approval's status: `PENDING_APPROVAL` unless a policy auto-approved. */
  status: string;
  aiConfidence: number;
  lintWarnings: string[];
  promptPackKey: string;
  recipientId: string;
}

export interface DraftServiceDeps {
  generator: ContentGenerator;
  /** Fills the `tenant` and `sender` namespaces of the prompt context. */
  identity: IdentityResolver;
  packs: PackRegistry;
  recipients: RecipientService;
  approvals: ApprovalService;
}

/** Which contact-point type a channel sends to. */
function contactTypeFor(channel: ChannelType): string {
  return channel === 'sms' || channel === 'voice' ? 'phone' : channel;
}

export class DraftService {
  constructor(private readonly deps: DraftServiceDeps) {}

  async draft(scope: TenantScope, input: DraftRequest): Promise<DraftResult> {
    const packKey = input.promptPackKey ?? DEFAULT_DRAFT_PROMPT_PACK;
    const pack = this.deps.packs.prompt(packKey);
    if (!pack) {
      throw new NotFoundError(`Prompt pack '${packKey}' not found`, {
        available: this.deps.packs.list(),
      });
    }

    const recipient = await this.resolveRecipient(scope, input);

    // The tenant name and the sender's display name come from the database,
    // not from `emptyContext()` — the prompt packs interpolate both, and a
    // model told it is "writing on behalf of  at " will write exactly that.
    const base = await this.deps.identity.baseContext(scope, input.senderId);

    const renderContext: RenderContext = {
      ...base,
      recipient: {
        id: recipient.id,
        displayName: recipient.displayName ?? undefined,
        firstName: recipient.firstName ?? undefined,
        lastName: recipient.lastName ?? undefined,
        timezone: recipient.timezone ?? undefined,
        locale: recipient.locale ?? undefined,
      },
      sender: { ...base.sender, id: input.senderId },
      context: { ...(input.context ?? {}) },
    };

    const draft = await this.deps.generator.generate({
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      pack,
      channel: input.channel,
      playbookGoal: input.goal,
      context: renderContext,
      overrides: input.overrides,
    });

    const to = this.contactPoint(recipient, input.channel);

    const submitted = await this.deps.approvals.submit(
      scope,
      {
        channel: input.channel,
        to,
        rendered: { subject: draft.subject, body: draft.content },
        recipientId: recipient.id,
        senderId: input.senderId,
        priority: input.priority ?? 'MEDIUM',
        aiGenerated: true,
        aiConfidence: draft.aiConfidence,
        // `threshold` mode counts errors; the generator reports the warnings
        // themselves. Passing the count is what the policy engine expects.
        lintErrors: draft.lintWarnings.length,
      },
      // No key means FALLBACK_POLICY — review everything. See the header.
      input.policyKey ? { key: input.policyKey } : {},
    );

    return {
      approvalId: submitted.approval?.id,
      messageId: submitted.approval?.messageId,
      content: draft.content,
      subject: draft.subject,
      status: submitted.approval?.status ?? 'PENDING_APPROVAL',
      aiConfidence: draft.aiConfidence,
      lintWarnings: draft.lintWarnings,
      promptPackKey: packKey,
      recipientId: recipient.id,
    };
  }

  private async resolveRecipient(scope: TenantScope, input: DraftRequest) {
    if (input.recipientId) {
      const row = await this.deps.recipients.getById(scope, input.recipientId);
      if (!row) throw new NotFoundError(`Recipient '${input.recipientId}' not found`);
      return row;
    }

    if (!input.externalRef) {
      throw new ValidationError('One of recipientId or externalRef is required');
    }

    const row = await this.deps.recipients.getOrResolve(scope, {
      kind: input.externalRef.system,
      id: input.externalRef.id,
    });
    if (!row) {
      throw new NotFoundError(
        `No recipient for ${input.externalRef.system}:${input.externalRef.id}, and the context provider could not resolve one`,
      );
    }
    return row;
  }

  /**
   * Where the draft would go. Refusing here rather than at dispatch is
   * deliberate: a draft nobody can send is an approval row a reviewer will
   * approve and then watch fail, and the model call has already been paid for by
   * the time dispatch would notice.
   */
  private contactPoint(
    recipient: { contactPoints: unknown },
    channel: ChannelType,
  ): ContactPoint {
    const wanted = contactTypeFor(channel);
    const points = (recipient.contactPoints ?? []) as Array<{
      type: string;
      value: string;
      primary?: boolean;
    }>;

    const found =
      points.find((p) => p.type === wanted && p.primary) ??
      points.find((p) => p.type === wanted);

    if (!found) {
      throw new ValidationError(
        `No ${wanted} contact point for this recipient; add one before generating a ${channel} draft`,
      );
    }
    return { type: found.type, value: found.value };
  }
}
