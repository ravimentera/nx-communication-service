/**
 * What a pack may contain, as Zod. Validated at load, not at first use.
 *
 * A pack is data supplied by whoever adopts the engine — a typo in a playbook's
 * channel plan is a config error, and it should surface at boot with a path and
 * a reason, not three weeks later as "no messages sent on Tuesday". The source's
 * equivalent failure mode is `default: logger.warn('Unknown event type')`, which
 * is how 27 of its 44 enum values came to have no handler without anyone
 * noticing.
 *
 * Every schema here is `.strict()`: an unrecognised key is an error rather than
 * being ignored. `templateKey` silently doing nothing because it was spelled
 * `template_key` is exactly the class of bug this catches.
 */
import { z } from 'zod';

import { CHANNEL_TYPES } from '../ports/channel.js';
import { PREDICATE_OPERATORS } from '../engine/playbooks/matcher.js';
import { TRIGGER_TYPES } from '../engine/playbooks/trigger.js';

const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const predicateSchema = z.record(
  z.string(),
  z
    .object(Object.fromEntries(PREDICATE_OPERATORS.map((op) => [op, z.unknown().optional()])))
    .strict(),
);

export const triggerDefinitionSchema = z
  .object({
    type: z.enum(TRIGGER_TYPES),
    eventType: z.string().min(1).optional(),
    /**
     * Extra accepted spellings. Not a convenience — the source's enum and its
     * switch disagree (`APPOINTMENT_RESCHEDULED` vs `APPOINTMENT_RESCHEDULING`,
     * `TREATMENT_COMPLETED` vs `TREATMENT_COMPLETION`), and both spellings are
     * in production callers today.
     */
    eventTypeAliases: z.array(z.string().min(1)).optional(),
    where: predicateSchema.optional(),
    cron: z.string().optional(),
  })
  .strict();

export const channelPlanEntrySchema = z
  .object({
    channel: z.enum(CHANNEL_TYPES),
    contactPointType: z.string().optional(),
    priority: priority.optional(),
    fallbackAfterMs: z.number().int().positive().optional(),
    /** Per-channel template override — a full email, a 160-character SMS. */
    templateKey: z.string().optional(),
    /**
     * An address that is not a recipient's: a Slack channel, an ops mailbox.
     * `$config.` prefixed values are resolved from `tenant_packs.config` at
     * install, which is where `emergency-team@medspa.com` now lives (D55).
     */
    fixedTarget: z.string().optional(),
  })
  .strict();

export const contentSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('template'),
      templateKey: z.string().min(1),
      subjectTemplateKey: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ai'),
      promptPackKey: z.string().min(1),
      goal: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('hybrid'),
      templateKey: z.string().min(1),
      promptPackKey: z.string().min(1),
      slot: z.string().min(1),
      goal: z.string().optional(),
    })
    .strict(),
]);

export const contractPropertySchema = z
  .object({
    type: z
      .union([
        z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']),
        z.array(z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])),
      ])
      .optional(),
    /**
     * Where the source read a field defensively (`data.patientName || 'there'`),
     * the ported contract marks it optional WITH that default. Making it
     * required would start failing events that work today.
     */
    default: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
    description: z.string().optional(),
  })
  .strict();

export const dataContractSchema = z
  .object({
    type: z.literal('object').optional(),
    required: z.array(z.string()).optional(),
    properties: z.record(z.string(), contractPropertySchema).optional(),
  })
  .strict();

export const playbookDefinitionSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
    priority: z.number().int().optional(),
    dataContract: dataContractSchema.optional(),
    /**
     * Accept a caller's spelling of a contract field without renaming the
     * contract. Values are dotted paths into the event context, tried in order;
     * put the contract's own field name first so a correct payload is untouched.
     * Deliberately name-to-name only — no transforms (D107).
     */
    contextMapping: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    /**
     * Raise the priority of a run when the context matches. The same bounded
     * predicate the trigger's `where` uses, evaluated against the event
     * context — deliberately not an expression language.
     */
    priorityRules: z
      .array(
        z
          .object({
            when: predicateSchema,
            priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
          })
          .strict(),
      )
      .optional(),
    contentSource: contentSourceSchema,
    channelPlan: z.array(channelPlanEntrySchema).min(1),
    /** Resolved to an id at install. Missing policy ⇒ install fails loudly. */
    approvalPolicyKey: z.string().optional(),
    throttle: z
      .object({
        maxPerRecipientPerDay: z.number().int().positive().optional(),
        cooldownHours: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    triggers: z.array(triggerDefinitionSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((playbook, ctx) => {
    // An AI-written message with no approval policy would send unreviewed
    // content. The engine cannot know a tenant's risk appetite, but it can
    // refuse to guess silently.
    if (playbook.contentSource.kind !== 'template' && !playbook.approvalPolicyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalPolicyKey'],
        message: `playbook '${playbook.key}' generates content with a model but names no approvalPolicyKey — state one explicitly, using 'system.transactional' if no review is wanted`,
      });
    }

    /**
     * D82, closed in P12.
     *
     * `OutreachTrigger` has no "run this playbook" field, so a campaign targets
     * its playbook through the predicate: the orchestrator puts
     * `campaignPlaybookKey` in the payload and a campaign-capable playbook
     * declares `where: {campaignPlaybookKey: {eq: '...'}}`.
     *
     * That works, and until now nothing enforced it. A pack author who omits the
     * predicate gets a playbook that fires on **every** campaign the tenant
     * runs — silently, with no warning, and discovered when an audience receives
     * a message meant for a different one.
     *
     * A loader check was the fix docs/PACKS.md proposed. This is it.
     */
    for (const [index, trigger] of (playbook.triggers ?? []).entries()) {
      if (trigger.type !== 'campaign') continue;
      if (trigger.where && 'campaignPlaybookKey' in trigger.where) continue;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', index, 'where'],
        message: `playbook '${playbook.key}' has a campaign trigger with no 'campaignPlaybookKey' predicate, so it would fire on every campaign this tenant runs — add where: { campaignPlaybookKey: { eq: '${playbook.key}' } }`,
      });
    }
  });

export const policyDefinitionSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    mode: z.enum(['always', 'threshold', 'sample', 'none']),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    sampleRate: z.number().min(0).max(1).optional(),
    approverResolution: z.record(z.string(), z.unknown()).optional(),
    rights: z
      .object({
        approve: z.boolean().optional(),
        edit: z.boolean().optional(),
        decline: z.boolean().optional(),
        reschedule: z.boolean().optional(),
        bulk: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sla: z
      .object({
        deadlineMs: z.number().int().positive().optional(),
        onExpiry: z.enum(['escalate', 'decline', 'approve']).optional(),
        fallbackApproverRef: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const templateDefinitionSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    channel: z.enum(CHANNEL_TYPES),
    subject: z.string().optional(),
    content: z.string().min(1),
    // Defaulted rather than optional, so a pack template always states its
    // format by the time it reaches the renderer.
    format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).default('TEXT'),
    category: z.string().optional(),
  })
  .strict();

/** The parsed shape, with `format` resolved. Use this, not the input type. */
export type TemplateDefinitionOut = z.output<typeof templateDefinitionSchema>;

export const manifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    requires: z.object({ engine: z.string() }).strict().optional(),
    /** Context provider kinds this pack unlocks — the P5 security gate (D37). */
    contextProviders: z.array(z.string()).optional(),
    /** Keys a tenant must set in `tenant_packs.config` before the pack works. */
    requiredConfig: z.array(z.string()).optional(),
  })
  .strict();

export type PlaybookDefinition = z.infer<typeof playbookDefinitionSchema>;
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
/** `z.output`, so `format` is present — `z.infer` on the input leaves it optional. */
export type TemplateDefinition = z.output<typeof templateDefinitionSchema>;
export type PackManifest = z.infer<typeof manifestSchema>;
export type TriggerDefinition = z.infer<typeof triggerDefinitionSchema>;

/** A readable one-line summary of where a pack file is wrong. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
