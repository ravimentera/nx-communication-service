/**
 * The render context — the generalization point of the whole content plane.
 *
 * Today templates interpolate `{{patientName}}`, `{{doctorName}}`,
 * `{{appointmentDate}}` and the 17-case handler switch supplies each variable by
 * hand. Nothing about those names is generic, and a non-medspa tenant has no
 * patients.
 *
 * The target context is five namespaces, and existing medspa templates keep
 * working untouched through a pack-level **alias map** (`packs/medspa/aliases.json`)
 * applied before compilation. That is what lets P9 migrate template rows without
 * rewriting a single template body.
 */

export interface RenderContext {
  recipient: {
    id?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    timezone?: string;
    locale?: string;
    [key: string]: unknown;
  };
  sender: {
    id?: string;
    displayName?: string;
    email?: string;
    [key: string]: unknown;
  };
  tenant: {
    id: string;
    name?: string;
    timezone?: string;
    locale?: string;
    [key: string]: unknown;
  };
  /** Caller-supplied, validated against the playbook's `data_contract`. */
  context: Record<string, unknown>;
  message: {
    channel?: string;
    playbookKey?: string;
    unsubscribeUrl?: string;
    [key: string]: unknown;
  };
  now: string;
}

export type AliasMap = Record<string, string>;

/**
 * Rewrite legacy variable names to context paths inside a template body.
 *
 * Applied to the raw template source before Handlebars compiles it, so
 * `{{patientName}}` becomes `{{recipient.displayName}}` and
 * `{{#if patientName}}` works too. Only bare identifiers are rewritten — a
 * path that already contains a dot is left alone, so a template that has been
 * migrated is unaffected by the map.
 */
export function applyAliases(source: string, aliases: AliasMap): string {
  if (Object.keys(aliases).length === 0) return source;

  // Matches an identifier inside {{ }}, optionally after a block helper and
  // possibly among other arguments: {{x}}, {{#if x}}, {{helper x y}}.
  return source.replace(/\{\{([^}]*)\}\}/g, (whole, inner: string) => {
    const rewritten = inner.replace(/(^|[\s(])([A-Za-z_][A-Za-z0-9_]*)(?=[\s)]|$)/g, (
      match,
      prefix: string,
      identifier: string,
    ) => {
      const target = aliases[identifier];
      return target ? `${prefix}${target}` : match;
    });
    return `{{${rewritten}}}`;
  });
}

/** Build a context with every namespace present, so lookups never hit undefined. */
export function emptyContext(tenantId: string): RenderContext {
  return {
    recipient: {},
    sender: {},
    tenant: { id: tenantId },
    context: {},
    message: {},
    now: new Date().toISOString(),
  };
}
