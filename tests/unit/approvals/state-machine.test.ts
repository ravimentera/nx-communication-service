/**
 * Exhaustive: every one of the 100 (from, to) pairs is asserted legal or
 * illegal. Not a sample — the whole point of a table-driven machine is that the
 * table is the specification, and a test that checks eight interesting cases
 * would not notice a row being edited.
 */
import {
  APPROVAL_STATUSES,
  APPROVED_STATES,
  InvalidTransitionError,
  TERMINAL_STATES,
  TRANSITIONS,
  appendAudit,
  canTransition,
  isTerminal,
  transition,
  type ApprovalStatus,
  type AuditEntry,
} from '../../../src/engine/approvals/state-machine.js';

const actor = { type: 'user' as const, ref: 'u-1', senderId: 'p-1' };

describe('the transition table', () => {
  it('covers every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...APPROVAL_STATUSES].sort());
  });

  it('never points at a status that does not exist', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(APPROVAL_STATUSES).toContain(to);
        expect(to).not.toBe(from); // no self-transitions
      }
    }
  });

  it('reaches every state from DRAFT', () => {
    // A state nothing can reach is dead code in a lookup table.
    const reachable = new Set<ApprovalStatus>(['DRAFT']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reachable]) {
        for (const to of TRANSITIONS[from]) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...APPROVAL_STATUSES].sort());
  });

  it('allows CANCELLED from every non-terminal state', () => {
    for (const status of APPROVAL_STATUSES) {
      if (isTerminal(status)) continue;
      expect(TRANSITIONS[status]).toContain('CANCELLED');
    }
  });
});

describe('every (from, to) pair', () => {
  const legal = new Set(
    APPROVAL_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}->${to}`)),
  );

  for (const from of APPROVAL_STATUSES) {
    for (const to of APPROVAL_STATUSES) {
      const expected = legal.has(`${from}->${to}`);

      it(`${from} -> ${to} is ${expected ? 'legal' : 'illegal'}`, () => {
        expect(canTransition(from, to)).toBe(expected);

        if (expected) {
          expect(transition({ from, to, actor }).status).toBe(to);
        } else {
          expect(() => transition({ from, to, actor })).toThrow(InvalidTransitionError);
        }
      });
    }
  }
});

describe('terminal states', () => {
  it('are exactly DECLINED, SENT and CANCELLED', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'DECLINED', 'SENT']);
  });

  it('reject everything, including themselves', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of APPROVAL_STATUSES) {
        expect(() => transition({ from, to, actor })).toThrow(InvalidTransitionError);
      }
    }
  });

  it('say so in the error, rather than listing an empty set of options', () => {
    try {
      transition({ from: 'DECLINED', to: 'APPROVED', actor });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as InvalidTransitionError).message).toContain('already DECLINED');
      expect((error as InvalidTransitionError).statusCode).toBe(409);
    }
  });
});

describe('APPROVED_STATES', () => {
  it('is the set from which a message may be released', () => {
    expect([...APPROVED_STATES].sort()).toEqual(['APPROVED', 'AUTO_APPROVED', 'EDITED_APPROVED']);
  });

  it('can all reach SENT', () => {
    for (const status of APPROVED_STATES) {
      expect(canTransition(status, 'SENT')).toBe(true);
    }
  });
});

describe('the audit trail', () => {
  it('records who, what and when', () => {
    const now = new Date('2026-03-08T12:00:00.000Z');
    const { entry } = transition({
      from: 'PENDING_APPROVAL',
      to: 'APPROVED',
      actor,
      reason: 'looks good',
      now,
    });

    expect(entry).toEqual({
      at: '2026-03-08T12:00:00.000Z',
      from: 'PENDING_APPROVAL',
      to: 'APPROVED',
      actorType: 'user',
      actorRef: 'u-1',
      reason: 'looks good',
    });
  });

  it('omits reason and contentHash rather than storing nulls', () => {
    const { entry } = transition({ from: 'DRAFT', to: 'AUTO_APPROVED', actor });
    expect(entry).not.toHaveProperty('reason');
    expect(entry).not.toHaveProperty('contentHash');
  });

  it('appends in order and never rewrites history', () => {
    const first: AuditEntry = {
      at: '2026-03-08T10:00:00.000Z',
      from: 'DRAFT',
      to: 'PENDING_APPROVAL',
      actorType: 'system',
      actorRef: 'policy:medspa.provider-always',
    };
    const second = transition({ from: 'PENDING_APPROVAL', to: 'APPROVED', actor }).entry;

    const trail = appendAudit([first], second);

    expect(trail).toHaveLength(2);
    expect(trail[0]).toEqual(first);
    expect(trail[1]).toEqual(second);
  });

  it('does not mutate the array it was given', () => {
    const original: AuditEntry[] = [];
    const next = appendAudit(original, transition({ from: 'DRAFT', to: 'CANCELLED', actor }).entry);
    expect(original).toHaveLength(0);
    expect(next).toHaveLength(1);
  });

  it('treats a malformed stored trail as empty rather than throwing', () => {
    // The column is untyped jsonb, and a legacy or hand-edited row may hold
    // anything. Losing the ability to record the current move would be worse
    // than losing a malformed past one.
    const entry = transition({ from: 'DRAFT', to: 'CANCELLED', actor }).entry;
    expect(appendAudit(null, entry)).toEqual([entry]);
    expect(appendAudit({ not: 'an array' }, entry)).toEqual([entry]);
  });
});
