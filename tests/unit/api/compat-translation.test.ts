/**
 * The vocabulary bridge, in isolation.
 *
 * `patientId ↔ recipientId` is the only one of the three renames that is not a
 * pure alias — a provider id *is* a sender id and a medspa id *is* a tenant id,
 * same value on both sides, but a patient id lives in patient-service's
 * namespace and the engine's recipient id is a UUID it minted. Everything the
 * compat shim returns passes through here, so a mistake shows up as a legacy
 * consumer silently reading the wrong id rather than as an error.
 */
import type { RecipientService } from '../../../src/engine/recipients/recipient.service.js';
import {
  CompatIdentity,
  MEDSPA_RECIPIENT_SYSTEM,
  fromLegacyChannel,
  legacyPagination,
  toLegacyChannel,
  toLegacyDirection,
  toLegacyMessage,
} from '../../../src/api/compat/translate.js';

const scope = { tenantId: 't1' };

type Row = {
  id: string;
  externalRef: { system: string; id: string } | null;
  displayName?: string;
};

function fakeRecipients(rows: Row[]): {
  service: RecipientService;
  upserts: Array<{ ref: unknown; patch: unknown }>;
} {
  const upserts: Array<{ ref: unknown; patch: unknown }> = [];
  const service = {
    getByExternalRef: async (_s: unknown, ref: { system: string; id: string }) =>
      rows.find((r) => r.externalRef?.system === ref.system && r.externalRef.id === ref.id) ?? null,
    listByIds: async (_s: unknown, ids: string[]) => rows.filter((r) => ids.includes(r.id)),
    upsertByExternalRef: async (_s: unknown, ref: unknown, patch: unknown) => {
      upserts.push({ ref, patch });
      const created = { id: 'r-new', externalRef: ref as Row['externalRef'] };
      rows.push(created);
      return created;
    },
  } as unknown as RecipientService;
  return { service, upserts };
}

describe('CompatIdentity', () => {
  it('resolves a legacy patient id through external_ref', async () => {
    const { service } = fakeRecipients([
      { id: 'r-1', externalRef: { system: MEDSPA_RECIPIENT_SYSTEM, id: 'p-1' } },
    ]);
    const identity = new CompatIdentity(service);
    expect(await identity.lookup(scope, 'p-1')).toBe('r-1');
  });

  it('returns null for an unknown patient rather than creating one on a read', async () => {
    // A read path must answer "no messages for that patient" with an empty
    // page. Creating a recipient row as a side effect of a GET would populate
    // the engine with everyone the FE ever looked at.
    const { service, upserts } = fakeRecipients([]);
    const identity = new CompatIdentity(service);
    expect(await identity.lookup(scope, 'p-unknown')).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  it('creates the recipient on a write path, carrying the contact point', async () => {
    const { service, upserts } = fakeRecipients([]);
    const identity = new CompatIdentity(service);

    const id = await identity.ensure(scope, 'p-2', {
      patientName: 'Ada',
      email: 'ada@example.test',
    });

    expect(id).toBe('r-new');
    expect(upserts[0]).toMatchObject({
      ref: { system: MEDSPA_RECIPIENT_SYSTEM, id: 'p-2' },
      patch: {
        displayName: 'Ada',
        contactPoints: [{ type: 'email', value: 'ada@example.test', primary: true }],
      },
    });
  });

  it('does not send an empty contactPoints array when no hints were given', async () => {
    // `upsertByExternalRef` COALESCEs its fields (D42), but an explicit empty
    // array is a value, not an absence — it would blank a recipient's known
    // addresses on any write that happened not to mention them.
    const { service, upserts } = fakeRecipients([]);
    await new CompatIdentity(service).ensure(scope, 'p-3');
    expect(upserts[0]!.patch).not.toHaveProperty('contactPoints');
  });

  it('translates a page of recipient ids back to patient ids in one lookup', async () => {
    const { service } = fakeRecipients([
      { id: 'r-1', externalRef: { system: MEDSPA_RECIPIENT_SYSTEM, id: 'p-1' } },
      { id: 'r-2', externalRef: { system: MEDSPA_RECIPIENT_SYSTEM, id: 'p-2' } },
    ]);
    const map = await new CompatIdentity(service).patientIds(scope, [
      'r-1',
      'r-2',
      'r-1',
      null,
      undefined,
    ]);
    expect(map.get('r-1')).toBe('p-1');
    expect(map.get('r-2')).toBe('p-2');
    expect(map.size).toBe(2);
  });

  it('falls back to the internal id for a recipient the engine created itself', async () => {
    // A staff Slack destination has no patient-service counterpart. A legacy
    // consumer uses this field only to round-trip, so a stable id is enough.
    const { service } = fakeRecipients([{ id: 'r-9', externalRef: null }]);
    const map = await new CompatIdentity(service).patientIds(scope, ['r-9']);
    expect(map.get('r-9')).toBe('r-9');
  });
});

describe('message translation', () => {
  const record = {
    id: 'm-1',
    recipientId: 'r-1',
    senderId: 'provider-7',
    tenantId: 'tenant-9',
    channel: 'email',
    content: 'hello',
    status: 'SENT',
    sentAt: new Date('2026-01-01T00:00:00Z'),
    deliveredAt: null,
    readAt: null,
    eventId: null,
    eventType: 'APPOINTMENT_REMINDER',
    notificationId: null,
    metadata: { messageType: 'REMINDER' },
    engagementData: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    engagementScore: 42,
    openedAt: null,
    clickedAt: null,
    repliedAt: null,
  };

  it('renames all three identity fields and drops the new ones', async () => {
    const legacy = toLegacyMessage(record, new Map([['r-1', 'p-1']]));

    expect(legacy).toMatchObject({
      patientId: 'p-1',
      providerId: 'provider-7',
      medspaId: 'tenant-9',
    });
    expect(legacy).not.toHaveProperty('recipientId');
    expect(legacy).not.toHaveProperty('senderId');
    expect(legacy).not.toHaveProperty('tenantId');
  });

  it('reports a null patientId rather than the internal uuid when unresolved', async () => {
    // Leaking a recipient UUID as a patientId is worse than a null: a client
    // would store it and send it back as a patient-service id.
    const legacy = toLegacyMessage(record, new Map());
    expect(legacy.patientId).toBeNull();
  });

  it('upper-cases the channel and lower-cases it back', () => {
    expect(toLegacyChannel('email')).toBe('EMAIL');
    expect(fromLegacyChannel('EMAIL')).toBe('email');
    expect(fromLegacyChannel(toLegacyChannel('in_app'))).toBe('in_app');
  });

  it('upper-cases direction, which used to live in metadata', () => {
    expect(toLegacyDirection('inbound')).toBe('INBOUND');
    expect(toLegacyDirection('outbound')).toBe('OUTBOUND');
  });
});

describe('legacyPagination', () => {
  it('reproduces the PaginatedResponse envelope', () => {
    expect(legacyPagination(2, 50, 120)).toEqual({
      page: 2,
      limit: 50,
      total: 120,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it('reports no pages and no next for an empty result', () => {
    expect(legacyPagination(1, 50, 0)).toMatchObject({
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
  });
});
