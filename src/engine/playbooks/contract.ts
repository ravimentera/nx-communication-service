/**
 * Validating caller-supplied context against a playbook's `data_contract`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS BEFORE ANYTHING ELSE
 *
 * The source validates nothing. `handleAppointmentRescheduling` destructures
 * `oldAppointment` and reads `oldAppointment.date` (:236, :246); an event
 * missing that field throws a TypeError, the outer catch turns it into
 * `return false`, and the caller logs "Event handling failed" with no indication
 * of which field was missing. `handleTreatmentInstructions` is worse — it reads
 * `instructions.summary` for SMS only (:415), so the same payload can succeed on
 * email and throw on SMS.
 *
 * Running the contract first means a bad payload costs a `FAILED` run row naming
 * the missing fields, and costs no LLM tokens and no partial send.
 *
 * OPTIONAL-WITH-DEFAULT IS THE RULE FOR PORTED FIELDS
 *
 * Where the source read a field defensively — `data.patientName || 'there'` — the
 * ported contract marks it optional with that default, NOT required. Making it
 * required would start failing events that work today, which is the one thing a
 * parity port must not do.
 *
 * SUPPORTED SUBSET
 *
 * JSON Schema is large and playbook contracts use a corner of it: `type:
 * object`, `required`, and per-property `type` / `default` / `enum`. Anything
 * else is **ignored, not rejected**, so a richer schema degrades to "check what
 * we understand" rather than failing every event. That is the same posture P4's
 * generator takes, and for the same reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export interface ContractProperty {
  type?: JsonSchemaType | JsonSchemaType[];
  default?: unknown;
  enum?: unknown[];
  description?: string;
}

export interface DataContract {
  type?: string;
  required?: string[];
  properties?: Record<string, ContractProperty>;
}

export type ContractResult =
  | { ok: true; context: Record<string, unknown> }
  | { ok: false; errors: string[] };

function typeOf(value: unknown): JsonSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  return 'string';
}

function typeMatches(expected: JsonSchemaType | JsonSchemaType[], actual: JsonSchemaType): boolean {
  const allowed = Array.isArray(expected) ? expected : [expected];
  // An integer satisfies `number`; the reverse is not true.
  return allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

/**
 * Check `context` against `contract`, applying declared defaults.
 *
 * Returns the context **with defaults filled in** on success, so the caller
 * renders from one object and does not have to remember which fields were
 * defaulted. A contract of `null` or `{}` accepts anything.
 */
export function validateContract(
  contract: DataContract | null | undefined,
  context: Record<string, unknown>,
): ContractResult {
  if (!contract?.properties && !contract?.required?.length) {
    return { ok: true, context };
  }

  const properties = contract.properties ?? {};
  const required = contract.required ?? [];
  const errors: string[] = [];
  const resolved: Record<string, unknown> = { ...context };

  // Defaults first, so a required field with a default is satisfied by it —
  // which is exactly how `data.patientName || 'there'` behaved.
  for (const [name, property] of Object.entries(properties)) {
    if (resolved[name] === undefined && property.default !== undefined) {
      resolved[name] = property.default;
    }
  }

  for (const name of required) {
    if (resolved[name] === undefined || resolved[name] === null) {
      errors.push(`missing required field '${name}'`);
    }
  }

  for (const [name, property] of Object.entries(properties)) {
    const value = resolved[name];
    if (value === undefined || value === null) continue; // absence is `required`'s business

    if (property.type && !typeMatches(property.type, typeOf(value))) {
      const expected = Array.isArray(property.type) ? property.type.join('|') : property.type;
      errors.push(`field '${name}' should be ${expected}, got ${typeOf(value)}`);
    }

    if (property.enum && !property.enum.includes(value)) {
      errors.push(`field '${name}' must be one of ${property.enum.map(String).join(', ')}`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, context: resolved };
}
