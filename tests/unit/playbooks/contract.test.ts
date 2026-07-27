/**
 * Data-contract validation.
 *
 * The rule this file exists to enforce: **optional-with-default, not required**,
 * wherever the source read a field defensively. `handlePatientRegistration`
 * reads `patientName` and the templates render `{{patientName}}` with no guard;
 * other call sites in the source use `data.x || 'there'`. Porting those as
 * `required` would start failing events that work in production today, which is
 * the one thing a parity port must not do.
 */
import { validateContract, type DataContract } from '../../../src/engine/playbooks/contract.js';

describe('an absent or empty contract', () => {
  it('accepts anything', () => {
    for (const contract of [null, undefined, {} as DataContract]) {
      const result = validateContract(contract, { anything: 1 });
      expect(result.ok).toBe(true);
    }
  });
});

describe('required fields', () => {
  const contract: DataContract = {
    type: 'object',
    required: ['appointmentDate'],
    properties: { appointmentDate: { type: 'string' }, doctorName: { type: 'string' } },
  };

  it('passes when present', () => {
    const result = validateContract(contract, { appointmentDate: '2026-03-09' });
    expect(result.ok).toBe(true);
  });

  it('names every missing field, not just the first', () => {
    const strict: DataContract = {
      required: ['a', 'b', 'c'],
      properties: { a: {}, b: {}, c: {} },
    };
    const result = validateContract(strict, { b: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toEqual([
      "missing required field 'a'",
      "missing required field 'c'",
    ]);
  });

  it('treats null as missing — a null appointmentDate renders as "null"', () => {
    const result = validateContract(contract, { appointmentDate: null });
    expect(result.ok).toBe(false);
  });
});

describe('defaults', () => {
  const contract: DataContract = {
    required: ['patientName'],
    properties: {
      patientName: { type: 'string', default: 'there' },
      tone: { type: 'string', default: 'professional' },
    },
  };

  it('fills a missing field, and that satisfies `required`', () => {
    // This is `data.patientName || 'there'` expressed as data. A contract that
    // required patientName outright would reject events the old handler sent.
    const result = validateContract(contract, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.context).toEqual({ patientName: 'there', tone: 'professional' });
  });

  it('does not overwrite a supplied value', () => {
    const result = validateContract(contract, { patientName: 'Ada' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.context.patientName).toBe('Ada');
  });

  it('does not mutate the caller’s object', () => {
    const supplied = {};
    validateContract(contract, supplied);
    expect(supplied).toEqual({});
  });
});

describe('types', () => {
  it('rejects a mismatch and says what it got', () => {
    const result = validateContract(
      { properties: { count: { type: 'number' } } },
      { count: 'seven' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors[0]).toBe("field 'count' should be number, got string");
  });

  it('accepts an integer where a number is declared, but not the reverse', () => {
    expect(validateContract({ properties: { n: { type: 'number' } } }, { n: 3 }).ok).toBe(true);
    expect(validateContract({ properties: { n: { type: 'integer' } } }, { n: 3.5 }).ok).toBe(false);
  });

  it('handles arrays and objects distinctly', () => {
    const contract: DataContract = {
      properties: { steps: { type: 'array' }, details: { type: 'object' } },
    };
    expect(validateContract(contract, { steps: ['a'], details: { x: 1 } }).ok).toBe(true);
    // `preparationSteps` is an array for email and joined for SMS in the source;
    // a contract declaring `array` catches a caller sending the joined string.
    expect(validateContract(contract, { steps: 'a. b', details: {} }).ok).toBe(false);
  });

  it('accepts a union of types', () => {
    const contract: DataContract = { properties: { x: { type: ['string', 'array'] } } };
    expect(validateContract(contract, { x: 'a' }).ok).toBe(true);
    expect(validateContract(contract, { x: ['a'] }).ok).toBe(true);
    expect(validateContract(contract, { x: 1 }).ok).toBe(false);
  });

  it('ignores the type of an absent optional field', () => {
    expect(validateContract({ properties: { x: { type: 'string' } } }, {}).ok).toBe(true);
  });
});

describe('enum', () => {
  it('constrains the value', () => {
    const contract: DataContract = {
      properties: { urgency: { type: 'string', enum: ['low', 'high'] } },
    };
    expect(validateContract(contract, { urgency: 'high' }).ok).toBe(true);
    const bad = validateContract(contract, { urgency: 'medium' });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.errors[0]).toMatch(/must be one of low, high/);
  });
});

describe('unsupported JSON Schema constructs', () => {
  it('are ignored rather than rejected', () => {
    // A richer schema should degrade to "check what we understand", not fail
    // every event — the same posture P4's generator takes.
    const contract = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      allOf: [{ required: ['b'] }],
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    } as unknown as DataContract;

    expect(validateContract(contract, { a: 'x', extra: true }).ok).toBe(true);
  });
});

describe('the full failure report', () => {
  it('collects every problem in one pass, so one fix round is enough', () => {
    const contract: DataContract = {
      required: ['a', 'b'],
      properties: { a: {}, b: {}, c: { type: 'number' }, d: { enum: ['x'] } },
    };
    const result = validateContract(contract, { c: 'no', d: 'y' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toHaveLength(4);
  });
});
