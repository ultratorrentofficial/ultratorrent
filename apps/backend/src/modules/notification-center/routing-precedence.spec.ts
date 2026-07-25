import { eventMatchKeys, eventSpecificity } from './notification-center.service';
import { RecipientProvisioningService } from './recipient-provisioning.service';

describe('routing profile event matching', () => {
  it('offers the exact event, its namespace wildcard, and the catch-all', () => {
    expect(eventMatchKeys('media_server.user_started_watching').sort()).toEqual(
      ['*', 'media_server.*', 'media_server.user_started_watching'].sort(),
    );
  });

  it('has no namespace key for an event without a namespace', () => {
    expect(eventMatchKeys('heartbeat').sort()).toEqual(['*', 'heartbeat'].sort());
  });

  it('ranks exact above namespace above catch-all', () => {
    expect(eventSpecificity('system.backup_failed')).toBeGreaterThan(eventSpecificity('system.*'));
    expect(eventSpecificity('system.*')).toBeGreaterThan(eventSpecificity('*'));
  });

  it('picks one line, never a union — an exception overrides a broad rule', () => {
    // "all system alerts by email, EXCEPT backup failures to Telegram". A union would
    // send backup failures to both, which is exactly what the operator asked not to.
    const lines = ['*', 'system.*', 'system.backup_failed'];
    const best = lines.sort((a, b) => eventSpecificity(b) - eventSpecificity(a))[0];
    expect(best).toBe('system.backup_failed');
  });
});

/**
 * The precedence the pipeline implements, exercised against the real resolution
 * order rather than a paraphrase of it. Mirrors `channelsFor()`:
 *   forced rule > recipient routing > rule channels > preferred > defaults.
 */
describe('channelsFor precedence', () => {
  const EMAIL = { id: 'ch-email', provider: 'email', enabled: true, isDefault: true };
  const TG = { id: 'ch-tg', provider: 'telegram', enabled: true, isDefault: true };

  function build(over: {
    rule?: Record<string, unknown>;
    routing?: Array<{ event: string; channelIds: string[] }>;
    recipient?: Record<string, unknown>;
    channels?: Array<Record<string, unknown>>;
  }) {
    const channels = over.channels ?? [EMAIL, TG];
    const prisma = {
      notificationChannel: {
        findMany: jest.fn(async ({ where }: any) => {
          let out = channels.filter((c: any) => c.enabled);
          if (where?.id?.in) out = out.filter((c: any) => where.id.in.includes(c.id));
          if (where?.isDefault) out = out.filter((c: any) => c.isDefault);
          return out;
        }),
        findFirst: jest.fn(async ({ where }: any) => channels.find((c: any) => c.id === where.id && c.enabled) ?? null),
      },
      notificationRouting: {
        findMany: jest.fn(async ({ where }: any) =>
          (over.routing ?? []).filter((r) => where.event.in.includes(r.event)),
        ),
      },
    };
    const rule = { event: 'media_server.user_started_watching', channelIds: [], forced: false, ...over.rule };
    const recipient = { id: 'r1', preferredChannelId: null, ...over.recipient };
    // Reach the private method the same way the pipeline does.
    const svc = Object.create(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./notification-center.service').NotificationCenterService.prototype,
    );
    svc.prisma = prisma;
    return { svc, rule, recipient };
  }

  const ids = (cs: any[]) => cs.map((c) => c.id).sort();

  it('falls back to the default channels when nothing is configured', async () => {
    const { svc, rule, recipient } = build({});
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-email', 'ch-tg']);
  });

  it("a recipient's routing profile beats the rule's channels — it can ADD a channel the rule never picked", async () => {
    // The core of the feature. The rule is pinned to email; the user wants this event
    // on Telegram. Opt-outs could only ever subtract, so this was impossible before.
    const { svc, rule, recipient } = build({
      rule: { channelIds: ['ch-email'] },
      routing: [{ event: 'media_server.user_started_watching', channelIds: ['ch-tg'] }],
    });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-tg']);
  });

  it('a namespace line routes every event under it', async () => {
    const { svc, rule, recipient } = build({
      routing: [{ event: 'media_server.*', channelIds: ['ch-tg'] }],
    });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-tg']);
  });

  it('an exact line overrides the namespace line for that one event', async () => {
    const { svc, rule, recipient } = build({
      routing: [
        { event: 'media_server.*', channelIds: ['ch-tg'] },
        { event: 'media_server.user_started_watching', channelIds: ['ch-email'] },
      ],
    });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-email']);
  });

  it('a FORCED rule ignores the routing profile — an admin pin the user cannot move', async () => {
    const { svc, rule, recipient } = build({
      rule: { channelIds: ['ch-email'], forced: true },
      routing: [{ event: 'media_server.user_started_watching', channelIds: ['ch-tg'] }],
    });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-email']);
  });

  it('a profile naming only disabled channels falls through instead of silently sending nowhere', async () => {
    // A stale selection (channel later disabled) must not become a black hole — that
    // would look identical to "delivered" from the operator's side.
    const { svc, rule, recipient } = build({
      channels: [EMAIL, { ...TG, enabled: false }],
      routing: [{ event: 'media_server.user_started_watching', channelIds: ['ch-tg'] }],
    });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-email']);
  });

  it("uses the recipient's preferred channel when there is no profile line and no rule channel", async () => {
    const { svc, rule, recipient } = build({ recipient: { preferredChannelId: 'ch-tg' } });
    expect(ids(await svc.channelsFor(rule, recipient))).toEqual(['ch-tg']);
  });
});

describe('RecipientProvisioningService.reconcile', () => {
  function build(users: any[], recipients: any[]) {
    const created: any[] = [];
    const updates: Array<{ id: string; data: any }> = [];
    const prisma = {
      user: { findMany: jest.fn(async () => users) },
      notificationRecipient: {
        findMany: jest.fn(async () => recipients),
        create: jest.fn(async ({ data }: any) => { created.push(data); return { id: `new-${created.length}`, ...data }; }),
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ id: where.id, data });
          const r = recipients.find((x) => x.id === where.id);
          Object.assign(r ?? {}, data);
          return r;
        }),
      },
    };
    return { svc: new RecipientProvisioningService(prisma as any), created, updates };
  }

  const user = (over: any = {}) => ({ id: 'u1', username: 'admin', email: 'a@b.c', displayName: 'Dennis Ayala', isActive: true, ...over });

  it('creates a recipient for a user that has none', async () => {
    const { svc, created } = build([user()], []);
    const s = await svc.reconcile();
    expect(s.created).toBe(1);
    expect(created[0]).toMatchObject({ userId: 'u1', displayName: 'Dennis Ayala', email: 'a@b.c', enabled: true });
  });

  it('ADOPTS an existing unlinked recipient by email instead of creating a duplicate', async () => {
    // The live case: a hand-made "Dennis Ayala" row carrying the admin's email and the
    // operator's Telegram chat id. Creating a second row would leave the configured
    // one orphaned and the notifications going to the empty one.
    const orphan = { id: 'r-old', userId: null, displayName: 'Dennis Ayala', email: 'A@B.C', telegramChatId: 'tg-123', enabled: true };
    const { svc, created, updates } = build([user()], [orphan]);
    const s = await svc.reconcile();
    expect(s.adopted).toBe(1);
    expect(s.created).toBe(0);
    expect(created).toHaveLength(0);
    expect(updates[0]).toMatchObject({ id: 'r-old', data: { userId: 'u1' } });
    expect(orphan.telegramChatId).toBe('tg-123'); // the configured address survives
  });

  it('leaves a genuine external recipient alone', async () => {
    const external = { id: 'r-ext', userId: null, displayName: 'On-call', email: 'oncall@x.y', enabled: true };
    const { svc, created, updates } = build([], [external]);
    const s = await svc.reconcile();
    expect(s).toMatchObject({ created: 0, adopted: 0, disabled: 0 });
    expect(updates).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('follows a rename and disables (never deletes) a deactivated user', async () => {
    const linked = { id: 'r1', userId: 'u1', displayName: 'Old Name', email: 'a@b.c', enabled: true };
    const { svc, updates } = build([user({ displayName: 'New Name', isActive: false })], [linked]);
    const s = await svc.reconcile();
    expect(s.updated).toBe(1);
    expect(updates[0].data).toMatchObject({ displayName: 'New Name', enabled: false });
  });

  it('disables a recipient whose user no longer exists', async () => {
    const stale = { id: 'r1', userId: 'gone', displayName: 'Ghost', email: null, enabled: true };
    const { svc, updates } = build([], [stale]);
    const s = await svc.reconcile();
    expect(s.disabled).toBe(1);
    expect(updates[0].data).toMatchObject({ enabled: false });
  });

  it('is idempotent — a second pass changes nothing', async () => {
    const linked = { id: 'r1', userId: 'u1', displayName: 'Dennis Ayala', email: 'a@b.c', enabled: true };
    const { svc } = build([user()], [linked]);
    expect(await svc.reconcile()).toMatchObject({ created: 0, adopted: 0, updated: 0, disabled: 0 });
  });
});
