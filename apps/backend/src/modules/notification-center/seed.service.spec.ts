import { NotificationSeedService } from './seed.service';

/**
 * The seed used to bail out entirely once any system rule existed. That protected
 * admin edits, but it also meant a catalog entry added in a later release never
 * reached an existing install — the event notified nobody, silently.
 */

const SEEDED_KEY = 'notification_center.seeded_rule_events';

function makeService(over: {
  seededEvents?: string[] | null;
  existingRules?: Array<{ event: string }>;
  modulesEnabled?: boolean;
} = {}) {
  const created: Array<{ event: string }> = [];
  let settingRow: { key: string; value: unknown } | null =
    over.seededEvents ? { key: SEEDED_KEY, value: over.seededEvents } : null;

  const prisma = {
    notificationRecipientGroup: {
      count: jest.fn(async () => 6),
      upsert: jest.fn(async () => ({ id: 'g1' })),
      findUnique: jest.fn(async () => ({ id: 'g-admins' })),
    },
    notificationRule: {
      count: jest.fn(async () => over.existingRules?.length ?? 0),
      findMany: jest.fn(async () => over.existingRules ?? []),
      createMany: jest.fn(async ({ data }: { data: Array<{ event: string }> }) => {
        created.push(...data); return { count: data.length };
      }),
    },
    setting: {
      findUnique: jest.fn(async () => settingRow),
      upsert: jest.fn(async ({ create, update }: { create: { value: unknown }; update: { value: unknown } }) => {
        settingRow = { key: SEEDED_KEY, value: settingRow ? update.value : create.value };
        return settingRow;
      }),
    },
  };
  const registry = { isEnabled: jest.fn(async () => over.modulesEnabled ?? true) };
  const service = new NotificationSeedService(prisma as never, registry as never);
  return { service, prisma, created, get setting() { return settingRow; } };
}

const seedRules = (s: NotificationSeedService) =>
  (s as unknown as { seedRules(id: string): Promise<void> }).seedRules('g-admins');

describe('notification rule seeding', () => {
  it('seeds the whole catalog on a fresh install', async () => {
    const h = makeService();
    await seedRules(h.service);
    expect(h.created.length).toBeGreaterThan(50);
    expect(h.created.map((r) => r.event)).toContain('library_cleanup.plan.pending_approval');
  });

  // The regression: an install seeded before these events existed must still get them.
  it('backfills only the entries an existing install never saw', async () => {
    const h = makeService({
      existingRules: [{ event: 'system.disk_space_low' }, { event: 'download.torrent_completed' }],
    });
    await seedRules(h.service);
    const events = h.created.map((r) => r.event);
    expect(events).toContain('library_cleanup.plan.pending_approval');
    expect(events).not.toContain('system.disk_space_low');
    expect(events).not.toContain('download.torrent_completed');
  });

  it('is idempotent — a second boot seeds nothing', async () => {
    const h = makeService();
    await seedRules(h.service);
    const first = h.created.length;
    await seedRules(h.service);
    expect(h.created.length).toBe(first);
  });

  // Keying off "does a rule for this event exist" would resurrect one an admin
  // deliberately deleted. The marker is what stops that.
  it('does not resurrect a system rule an admin deleted', async () => {
    const h = makeService({ seededEvents: ['system.disk_space_low'], existingRules: [] });
    await seedRules(h.service);
    expect(h.created.map((r) => r.event)).not.toContain('system.disk_space_low');
  });

  it('records every catalog event as seeded, so later boots stay quiet', async () => {
    const h = makeService();
    await seedRules(h.service);
    const recorded = h.setting!.value as string[];
    expect(recorded).toContain('library_cleanup.plan.expired');
    expect(recorded).toContain('workflow.approval.requested');
  });
});
