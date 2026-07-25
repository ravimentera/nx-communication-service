/**
 * Builds the final prompt from pack data. **Deterministic** — same inputs, same
 * string, every time.
 *
 * The prompts this replaces are inlined template literals in
 * `ai-message-generator.ts:113-148` and `:183-223`, interpolating patient and
 * provider ids straight into the text. They cannot be reviewed, versioned,
 * A/B'd or changed without a deploy, and a non-medspa tenant inherits medical
 * aesthetics vocabulary it has no use for.
 *
 * Section order is fixed and documented, because the assembled prompt is stored
 * on the `ai_interactions` row: if the order drifted, stored prompts would stop
 * being comparable and prompt regressions would become invisible.
 *
 *   1. persona            — who is writing (pack)
 *   2. goal               — what this message is for (playbook, else pack)
 *   3. constraints        — pack constraints, then tenant compliance profile
 *   4. channel rules      — formatting limits for the target channel
 *   5. tenant style       — optional per-tenant voice
 *   6. context            — the validated, caller-supplied JSON
 *   7. output contract    — what shape to return
 */
import { Renderer } from './renderer.js';
import type { RenderContext } from './render-context.js';

export interface PromptPack {
  key: string;
  version: number;
  persona?: string;
  goal?: string;
  constraints?: string[];
  channelRules?: Record<string, string>;
  modelHints?: { temperature?: number; maxTokens?: number; model?: string };
}

export interface AssembleInput {
  pack: PromptPack;
  /** Overrides the pack goal when the playbook states its own. */
  playbookGoal?: string;
  channel: string;
  context: RenderContext;
  /** From `tenants.compliance_profile` — e.g. HIPAA, TCPA obligations. */
  complianceConstraints?: string[];
  /** From `tenants.settings.styleProfile` — the tenant's voice. */
  tenantStyle?: string;
  outputContract?: string;
}

export interface AssembledPrompt {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  packKey: string;
  packVersion: number;
}

const DEFAULT_OUTPUT_CONTRACT = [
  'Return a single JSON object with these fields:',
  '  content  — the message body, plain text unless the channel rules say otherwise',
  '  subject  — a subject line, only when the channel supports one',
  '  tone     — a short description of the tone you used',
  '  reasoning — one sentence on why this message is appropriate',
].join('\n');

export class PromptAssembler {
  constructor(private readonly renderer: Renderer) {}

  async assemble(input: AssembleInput): Promise<AssembledPrompt> {
    const { pack, channel, context } = input;

    // The persona carries {{sender.displayName}} / {{tenant.name}} — render it
    // through the same engine templates use, so one substitution mechanism
    // covers both and a persona cannot reference a path a template could not.
    const persona = pack.persona
      ? (await this.renderer.render(pack.persona, context, { format: 'TEXT' })).output
      : '';

    const constraints = [...(pack.constraints ?? []), ...(input.complianceConstraints ?? [])];
    const channelRule = pack.channelRules?.[channel] ?? pack.channelRules?.[channel.toLowerCase()];

    const systemSections: string[] = [];
    if (persona) systemSections.push(persona);
    if (constraints.length > 0) {
      systemSections.push(
        ['Constraints:', ...constraints.map((c) => `- ${c}`)].join('\n'),
      );
    }
    if (channelRule) systemSections.push(`Channel rules (${channel}):\n${channelRule}`);
    if (input.tenantStyle) systemSections.push(`House style:\n${input.tenantStyle}`);

    const goal = input.playbookGoal ?? pack.goal ?? '';
    const promptSections: string[] = [];
    if (goal) promptSections.push(`Task:\n${goal}`);
    promptSections.push(
      `Context (all facts you may use — do not invent others):\n${JSON.stringify(
        {
          recipient: context.recipient,
          sender: context.sender,
          tenant: { name: context.tenant.name, timezone: context.tenant.timezone },
          ...context.context,
        },
        null,
        2,
      )}`,
    );
    promptSections.push(input.outputContract ?? DEFAULT_OUTPUT_CONTRACT);

    return {
      system: systemSections.join('\n\n'),
      prompt: promptSections.join('\n\n'),
      temperature: pack.modelHints?.temperature,
      maxTokens: pack.modelHints?.maxTokens,
      model: pack.modelHints?.model,
      packKey: pack.key,
      packVersion: pack.version,
    };
  }
}
