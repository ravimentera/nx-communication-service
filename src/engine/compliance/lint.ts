/**
 * Content lint. Fills the ruleset hook stubbed in P4's `generator.ts`.
 *
 * Rules are **data**, not code (§0.10 tier 1): engine-level defaults that every
 * pack inherits, plus per-pack rules loaded from `packs/<id>/compliance.json`.
 * Nothing here knows what HIPAA is — the medspa pack does.
 *
 * Lint produces warnings, never hard failures. Its output feeds `aiConfidence`
 * (D35) and, through that, P6's approval threshold: the effect of a lint hit is
 * that a human is more likely to look at the draft, which is the right response
 * to "this might be non-compliant" and a far better one than silently refusing
 * to send.
 */
export interface LintRules {
  prohibitedPhrases?: string[];
  requiredDisclaimers?: string[];
  maxLength?: Record<string, number>;
  /** Regex sources, matched case-insensitively. */
  phiPatterns?: string[];
  linkPolicy?: 'any' | 'allowlist';
  allowedDomains?: string[];
}

export interface LintInput {
  content: string;
  channel: string;
  tenantId: string;
  transactional?: boolean;
}

/**
 * Engine defaults every pack inherits. Deliberately thin and vertical-neutral:
 * length ceilings that mirror the channel capabilities, and the CAN-SPAM/TCPA
 * obligations that apply to anyone sending bulk messages in the US.
 */
export const DEFAULT_RULES: LintRules = {
  maxLength: { sms: 320, push: 1000 },
  linkPolicy: 'any',
};

const URL_RE = /https?:\/\/([^\s/$.?#]+\.[^\s]*)/gi;

export function lintContent(input: LintInput, rules: LintRules = DEFAULT_RULES): string[] {
  const warnings: string[] = [];
  const content = input.content;
  const lower = content.toLowerCase();

  const max = rules.maxLength?.[input.channel] ?? rules.maxLength?.[input.channel.toLowerCase()];
  if (max && content.length > max) {
    warnings.push(`content is ${content.length} characters, over the ${max} limit for ${input.channel}`);
  }

  for (const phrase of rules.prohibitedPhrases ?? []) {
    if (lower.includes(phrase.toLowerCase())) {
      warnings.push(`contains prohibited phrase "${phrase}"`);
    }
  }

  for (const disclaimer of rules.requiredDisclaimers ?? []) {
    if (!lower.includes(disclaimer.toLowerCase())) {
      warnings.push(`missing required disclaimer "${disclaimer}"`);
    }
  }

  for (const pattern of rules.phiPatterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(content)) {
        warnings.push(`matches restricted pattern /${pattern}/i`);
      }
    } catch {
      // A malformed rule must not break linting for everyone else.
      warnings.push(`lint rule /${pattern}/ is not a valid regular expression`);
    }
  }

  if (rules.linkPolicy === 'allowlist') {
    const allowed = (rules.allowedDomains ?? []).map((d) => d.toLowerCase());
    for (const match of content.matchAll(URL_RE)) {
      const host = (match[1] ?? '').split('/')[0]?.toLowerCase() ?? '';
      const permitted = allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
      if (!permitted) warnings.push(`links to a domain outside the allowlist: ${host}`);
    }
  }

  return warnings;
}

/** Merge pack rules over the engine defaults. */
export function mergeRules(...layers: (LintRules | undefined)[]): LintRules {
  const merged: LintRules = { ...DEFAULT_RULES };
  for (const layer of layers) {
    if (!layer) continue;
    merged.prohibitedPhrases = [
      ...(merged.prohibitedPhrases ?? []),
      ...(layer.prohibitedPhrases ?? []),
    ];
    merged.requiredDisclaimers = [
      ...(merged.requiredDisclaimers ?? []),
      ...(layer.requiredDisclaimers ?? []),
    ];
    merged.phiPatterns = [...(merged.phiPatterns ?? []), ...(layer.phiPatterns ?? [])];
    merged.maxLength = { ...(merged.maxLength ?? {}), ...(layer.maxLength ?? {}) };
    if (layer.linkPolicy) merged.linkPolicy = layer.linkPolicy;
    if (layer.allowedDomains) {
      merged.allowedDomains = [...(merged.allowedDomains ?? []), ...layer.allowedDomains];
    }
  }
  return merged;
}
