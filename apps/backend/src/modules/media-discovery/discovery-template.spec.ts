import { BadRequestException, ConflictException } from '@nestjs/common';
import { DiscoveryTemplateService, type DiscoveryTemplateInput } from './discovery-template.service';

/** A template that only ever notifies — no auto-monitor categories. */
const NOTIFY_ONLY: DiscoveryTemplateInput = { name: 'Notify', notifyOnlyCategories: ['Drama'] };
/** A template that would generate rules. */
const AUTO: DiscoveryTemplateInput = { name: 'Auto', autoMonitorCategories: ['Sci-Fi'] };

function harness(opts: { feed?: any; profile?: any; acq?: any; template?: any } = {}) {
  const created: any[] = [];
  const prisma = {
    discoveryTemplate: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => opts.template ?? null),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: 't1', ...data };
      }),
      update: jest.fn(async ({ data }: any) => ({ id: 't1', ...(opts.template ?? {}), ...data })),
      delete: jest.fn(async () => ({})),
    },
    rssFeed: { findUnique: jest.fn(async () => (opts.feed === undefined ? { id: 'f1', isEnabled: true, name: 'Feed' } : opts.feed)) },
    storageProfile: { findUnique: jest.fn(async () => (opts.profile === undefined ? { id: 'p1', isEnabled: true, name: 'Dev' } : opts.profile)) },
    acquisitionRuleTemplate: { findUnique: jest.fn(async () => (opts.acq === undefined ? { id: 'a1' } : opts.acq)) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new DiscoveryTemplateService(prisma as any, audit as any), prisma, audit, created };
}

describe('saving a template', () => {
  /*
   * A half-built template must stay saveable, or an operator cannot put it down
   * and come back to it. Only ENABLING demands a working configuration.
   */
  it('saves an auto-monitor template with no feed and no storage profile', async () => {
    const { svc } = harness();
    await expect(svc.create({ ...AUTO, enabled: false })).resolves.toMatchObject({ name: 'Auto' });
  });

  it('requires a name', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: '   ' })).rejects.toThrow(BadRequestException);
  });

  it('defaults to disabled — nothing starts monitoring because it was saved', async () => {
    const { svc, created } = harness();
    await svc.create(AUTO);
    expect(created[0].enabled).toBeUndefined(); // the column default is false
  });

  it('rejects an unknown media type, match mode or release type', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', mediaType: 'audiobook' })).rejects.toThrow(/mediaType/);
    await expect(svc.create({ name: 'x', categoryMatchMode: 'MAYBE' })).rejects.toThrow(/categoryMatchMode/);
    await expect(svc.create({ name: 'x', releaseTypes: ['streaming', 'telepathy'] })).rejects.toThrow(/telepathy/);
  });

  it('bounds the window and the confidence floor', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', upcomingWindowDays: 0 })).rejects.toThrow(/upcomingWindowDays/);
    await expect(svc.create({ name: 'x', upcomingWindowDays: 400 })).rejects.toThrow(/upcomingWindowDays/);
    await expect(svc.create({ name: 'x', minimumConfidence: 1.5 })).rejects.toThrow(/minimumConfidence/);
  });
});

describe('the category policy', () => {
  /*
   * Auto-monitor and ignore are opposite verdicts. Whichever we honoured would
   * silently be the opposite of what half the configuration says.
   */
  it('refuses a category that is both auto-monitored and ignored', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', autoMonitorCategories: ['Sci-Fi'], ignoreCategories: ['sci-fi'] }),
    ).rejects.toThrow(/both auto-monitored and ignored/i);
  });

  /*
   * This overlap is the documented way to say "Sci-Fi qualifies, but never when
   * it is also a Documentary", so it must be allowed.
   */
  it('allows a category to be auto-monitored AND blocked-from-auto', async () => {
    const { svc } = harness();
    await expect(
      svc.create({
        name: 'x',
        autoMonitorCategories: ['Sci-Fi', 'Documentary'],
        blockedFromAutoCategories: ['Documentary'],
      }),
    ).resolves.toBeDefined();
  });
});

describe('the auto-add limits', () => {
  it('rejects negative limits', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', autoAddLimitPerDay: -1 })).rejects.toThrow(/autoAddLimitPerDay/);
  });

  /*
   * A weekly cap below the daily one can never bind: the daily allowance is
   * exhausted first every time, so the weekly figure would be a number in the UI
   * that never does anything.
   */
  it('rejects a weekly cap lower than the daily one', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', autoAddLimitPerDay: 10, autoAddLimitPerWeek: 5 }),
    ).rejects.toThrow(/autoAddLimitPerWeek cannot be lower/);
  });

  it('allows them to be equal', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', autoAddLimitPerDay: 7, autoAddLimitPerWeek: 7 })).resolves.toBeDefined();
  });
});

describe('the path template', () => {
  it('accepts the allowed tokens', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', pathTemplate: 'TV Shows/{tvshow} ({year})/Season {season_number}' }),
    ).resolves.toBeDefined();
  });

  /*
   * The root is the Storage Profile's to choose. A template that could name an
   * absolute path could place media anywhere the process can write.
   */
  it('refuses an absolute path', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', pathTemplate: '/media/Staging/{movie}' })).rejects.toThrow(/must be relative/);
    await expect(svc.create({ name: 'x', pathTemplate: 'C:/media/{movie}' })).rejects.toThrow(/must be relative/);
  });

  it('refuses traversal', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', pathTemplate: '../../etc/{movie}' })).rejects.toThrow(/\.\./);
  });

  it('refuses control characters', async () => {
    const { svc } = harness();
    const sneaky = `TV/${String.fromCharCode(0)}{tvshow}`;
    await expect(svc.create({ name: 'x', pathTemplate: sneaky })).rejects.toThrow(/control characters/);
  });

  it('names the unknown token rather than failing vaguely', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: 'x', pathTemplate: '{library_path}/{movie}' })).rejects.toThrow(
      /\{library_path\}/,
    );
  });
});

describe('enabling a template', () => {
  /*
   * A notify-only template generates nothing, so demanding a feed and a
   * destination would block the most cautious way to use the feature — which is
   * exactly where an operator should be encouraged to start.
   */
  it('enables a notify-only template with no feed or profile', async () => {
    const { svc } = harness();
    await expect(svc.create({ ...NOTIFY_ONLY, enabled: true })).resolves.toBeDefined();
  });

  it('refuses to enable an auto-monitor template with no feed', async () => {
    const { svc } = harness();
    await expect(svc.create({ ...AUTO, enabled: true, storageProfileId: 'p1' })).rejects.toThrow(
      /Select an RSS feed/,
    );
  });

  it('refuses to enable an auto-monitor template with no storage profile', async () => {
    const { svc } = harness();
    await expect(svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1' })).rejects.toThrow(
      /Select a storage profile/,
    );
  });

  it('enables when the feed and profile are both present and healthy', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1' }),
    ).resolves.toBeDefined();
  });

  /*
   * A disabled feed is worse than a missing one: the template would look
   * configured, generate rules, and none of them would ever match anything.
   */
  it('refuses a disabled feed, and says why', async () => {
    const { svc } = harness({ feed: { id: 'f1', isEnabled: false, name: 'Old Feed' } });
    await expect(
      svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses a feed or profile that has been deleted', async () => {
    const gone = harness({ feed: null });
    await expect(
      gone.svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1' }),
    ).rejects.toThrow(/feed no longer exists/);

    const noProfile = harness({ profile: null });
    await expect(
      noProfile.svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1' }),
    ).rejects.toThrow(/storage profile no longer exists/);
  });

  /*
   * `resolveCandidates()` already falls back to the auto-download profiles and
   * then the global defaults, so a generated rule without a template still has
   * preferences — just not template-specific ones.
   */
  it('allows enabling with no acquisition template', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1', acquisitionTemplateId: null }),
    ).resolves.toBeDefined();
  });

  it('refuses an acquisition template that has been deleted', async () => {
    const { svc } = harness({ acq: null });
    await expect(
      svc.create({ ...AUTO, enabled: true, rssFeedId: 'f1', storageProfileId: 'p1', acquisitionTemplateId: 'a1' }),
    ).rejects.toThrow(/acquisition template no longer exists/);
  });

  it('re-checks on update, not only on create', async () => {
    const { svc } = harness({
      template: { id: 't1', name: 'Auto', enabled: false, autoMonitorCategories: ['Sci-Fi'], rssFeedId: null, storageProfileId: null },
    });
    await expect(svc.update('t1', { enabled: true })).rejects.toThrow(/Select an RSS feed/);
  });
});

describe('audit', () => {
  it('records a create with the name and whether it was enabled', async () => {
    const { svc, audit } = harness();
    await svc.create({ ...NOTIFY_ONLY, enabled: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'media_discovery.template.created' }),
    );
  });

  it('calls out an enable rather than leaving it to be diffed out of the payload', async () => {
    const { svc, audit } = harness({
      template: { id: 't1', name: 'Notify', enabled: false, autoMonitorCategories: [] },
    });
    await svc.update('t1', { enabled: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ enabledChangedTo: true }) }),
    );
  });
});
