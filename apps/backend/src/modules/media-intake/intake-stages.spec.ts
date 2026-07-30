/**
 * The pre-import stages.
 *
 * All three work on a path rather than an item, and each has one decision that
 * matters more than the rest: identify must refuse to guess a library, quality
 * must not block an import it merely failed to measure, and the import plan
 * must be recorded before it is executed.
 */
import { IntakeStagesService } from './intake-stages.service';

let destinationExists = false;
jest.mock('node:fs/promises', () => ({
  stat: jest.fn(async () => {
    if (!destinationExists) throw new Error('ENOENT');
    return { size: 1 };
  }),
}));
import type { IntakeStage, StageContext } from './intake-pipeline.service';

const parsed = { value: { title: 'Some Show', season: 1, episode: 2 } as Record<string, unknown> };
const kind = { value: 'tv' as string };
jest.mock('../media/media-identification.service', () => ({
  parseItemIdentity: jest.fn(() => parsed.value),
}));
jest.mock('../media/media-renamer', () => ({ kindFromParsed: jest.fn(() => kind.value) }));

const PROFILE = {
  id: 'p1', stagingRoot: '/staging', defaultStrategy: 'auto',
  movieLibrary: { id: 'lib-m', name: 'Movies' },
  tvLibrary: { id: 'lib-tv', name: 'TV Shows' },
  musicLibrary: null,
};

function build(over: {
  profile?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  library?: Record<string, unknown> | null;
  probeAvailable?: boolean;
  probeThrows?: boolean;
  planItems?: Array<Record<string, unknown>>;
  outcome?: Record<string, unknown>;
} = {}) {
  const stages = new Map<string, IntakeStage>();
  const updates: Record<string, unknown>[] = [];
  const recorded: Array<{ strategy: string; reason: string }> = [];

  const prisma = {
    storageProfile: { findUnique: jest.fn(async () => over.profile === undefined ? PROFILE : over.profile) },
    mediaIntakeJob: {
      findUnique: jest.fn(async () => over.job === undefined ? { id: 'j1', libraryId: 'lib-tv' } : over.job),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => { updates.push(a.data); return {}; }),
    },
    mediaLibrary: {
      findUnique: jest.fn(async () => over.library === undefined
        ? { id: 'lib-tv', name: 'TV Shows', path: '/media/TV' } : over.library),
    },
  };
  const pipeline = { register: jest.fn((s: IntakeStage) => stages.set(s.produces, s)) };
  const probe = {
    isAvailable: jest.fn(async () => over.probeAvailable ?? true),
    probe: jest.fn(async () => {
      if (over.probeThrows) throw new Error('ffprobe exited 1');
      return { height: 1080, bitrateKbps: 8000, videoCodec: 'hevc', resolution: '1080p' };
    }),
  };
  const capabilities = {
    probe: jest.fn(async () => ({
      sameDevice: true, hardlink: true, reflink: false, symlink: true,
      providerRelocation: false, filesystem: 'ext4',
    })),
  };
  const intake = {
    recordStrategy: jest.fn(async (_id: string, strategy: string, reason: string) => {
      recorded.push({ strategy, reason });
      return {};
    }),
  };

  const executed: Array<Record<string, unknown>> = [];
  const media = {
    buildPlan: jest.fn(async () => ({
      items: over.planItems ?? [{
        source: '/staging/Some.Show.S01E02.mkv',
        destination: '/media/TV/Some Show/Some Show - S01E02.mkv',
        skipped: false, unchanged: false,
      }],
    })),
  };
  const strategies = {
    execute: jest.fn(async (req: Record<string, unknown>) => {
      executed.push(req);
      return {
        strategy: 'hardlink', reason: 'same device', fellBack: false,
        destination: req.destination, sourcePreserved: true, ...over.outcome,
      };
    }),
  };

  const svc = new IntakeStagesService(
    prisma as never, pipeline as never, probe as never, capabilities as never,
    intake as never, media as never, strategies as never,
  );
  jest.spyOn((svc as never as { logger: { debug: (m: string) => void } }).logger, 'debug')
    .mockImplementation(() => undefined);
  svc.onModuleInit();
  jest.spyOn((svc as never as { logger: { warn: (m: string) => void } }).logger, 'warn')
    .mockImplementation(() => undefined);
  return { svc, stages, prisma, updates, recorded, capabilities, probe, media, strategies, executed };
}

const ctx: StageContext = {
  jobId: 'j1', sourcePath: '/staging/Some.Show.S01E02.mkv',
  profileId: 'p1', torrentHash: 'abc', engineId: 'e1',
};

beforeEach(() => {
  parsed.value = { title: 'Some Show', season: 1, episode: 2 };
  kind.value = 'tv';
  destinationExists = false;
});

describe('identify', () => {
  it('registers every stage it provides', () => {
    const { stages } = build();
    expect([...stages.keys()]).toEqual([
      'identified', 'quality_scored', 'ready_to_import', 'importing', 'imported',
    ]);
  });

  it('routes a parsed TV release to the TV library', async () => {
    const { stages, updates } = build();
    const out = await stages.get('identified')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(updates[0]).toMatchObject({ libraryId: 'lib-tv' });
    expect(out.message).toMatch(/TV Shows/);
  });

  it('routes a film to the movie library', async () => {
    kind.value = 'movie';
    const { stages, updates } = build();
    await stages.get('identified')!.run(ctx);
    expect(updates[0]).toMatchObject({ libraryId: 'lib-m' });
  });

  it('QUARANTINES rather than guessing when the profile has no library for the kind', async () => {
    /*
     * The important refusal. Importing into "whichever library exists" would
     * file a film in a TV tree, and a configuration gap is not something a
     * retry can close — it needs a person.
     */
    kind.value = 'music';
    const { stages, updates } = build();
    const out = await stages.get('identified')!.run(ctx);
    expect(out.quarantine?.reason).toMatch(/no library for it/);
    expect(updates).toHaveLength(0);
  });

  it('quarantines an unrecognised kind instead of picking a library', async () => {
    // `general` is genuinely unknown — a sample or a scene extra.
    kind.value = 'general';
    const { stages } = build();
    expect((await stages.get('identified')!.run(ctx)).quarantine).toBeDefined();
  });

  it('quarantines when the profile has been deleted mid-run', async () => {
    const { stages } = build({ profile: null });
    expect((await stages.get('identified')!.run(ctx)).quarantine).toBeDefined();
  });
});

describe('quality scoring', () => {
  it('scores from the probed file, not the release name', async () => {
    // A name claiming 1080p is a claim; ffprobe reads the real height.
    const { stages, updates } = build();
    const out = await stages.get('quality_scored')!.run(ctx);
    expect(updates[0].qualityScore).toBeGreaterThan(0);
    expect(out.message).toMatch(/1080p/);
  });

  it('ranks a higher resolution above a higher bitrate', async () => {
    // Resolution is the difference people notice; bitrate only breaks ties.
    const score = (h: number, b: number) =>
      (build().svc as never as { scoreOf: (t: unknown) => number }).scoreOf({ height: h, bitrateKbps: b });
    expect(score(2160, 1000)).toBeGreaterThan(score(1080, 100000));
  });

  it('does NOT block the import when ffprobe is unavailable', async () => {
    /*
     * ffprobe is optional in this deployment. Refusing to import because a
     * nice-to-have measurement could not be taken is a worse outcome than
     * importing unscored.
     */
    const { stages, updates } = build({ probeAvailable: false });
    const out = await stages.get('quality_scored')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(updates).toHaveLength(0);
    expect(out.message).toMatch(/unavailable/);
  });

  it('does NOT fail the intake when the probe throws', async () => {
    const { stages } = build({ probeThrows: true });
    const out = await stages.get('quality_scored')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(out.message).toMatch(/Could not probe/);
  });
});

describe('import planning', () => {
  it('measures capabilities against the real source and destination', async () => {
    // A general belief about the install is not the same as this pair of paths.
    const { stages, capabilities } = build();
    await stages.get('ready_to_import')!.run(ctx);
    expect(capabilities.probe).toHaveBeenCalledWith('p1', '/staging', '/media/TV', 'e1');
  });

  it('records the strategy and its reason BEFORE the import runs', async () => {
    // An intake that dies mid-import must still say what it was attempting.
    const { stages, recorded } = build();
    await stages.get('ready_to_import')!.run(ctx);
    expect(recorded[0].strategy).toBe('hardlink');
    expect(recorded[0].reason).toBeTruthy();
  });

  it('quarantines when no destination library was resolved', async () => {
    const { stages } = build({ job: { id: 'j1', libraryId: null } });
    expect((await stages.get('ready_to_import')!.run(ctx)).quarantine).toBeDefined();
  });

  it('quarantines when the destination library has been deleted', async () => {
    const { stages } = build({ library: null });
    expect((await stages.get('ready_to_import')!.run(ctx)).quarantine).toBeDefined();
  });
});


describe('placement', () => {
  it('takes the destination from the rename engine, in preview mode', async () => {
    /*
     * The library already owns a naming preset and template. A second opinion
     * about what a file should be called is how intake and a library scan end
     * up disagreeing about the same release. `preview` so the renamer computes
     * paths and moves nothing — every byte is moved by the strategy executor.
     */
    const { stages, media, executed } = build();
    await stages.get('imported')!.run(ctx);
    expect(media.buildPlan).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'preview', libraryPath: '/media/TV' }),
    );
    expect(executed[0].destination).toBe('/media/TV/Some Show/Some Show - S01E02.mkv');
  });

  it('SKIPS a file already at its destination, so a retry is safe', async () => {
    /*
     * buildPlan derives the destination from the SOURCE, which is still in
     * staging after a partial run — so its `unchanged` flag stays false and
     * cannot be relied on. Without this check a resumed import places the same
     * file twice and link() throws EEXIST on the second.
     */
    destinationExists = true;
    const { stages, executed } = build();
    const out = await stages.get('imported')!.run(ctx);
    expect(executed).toHaveLength(0);
    expect(out.message).toMatch(/already present/);
    expect(out.quarantine).toBeUndefined();
  });

  it('ignores plan entries the renamer skipped or left unchanged', async () => {
    const { stages, executed } = build({
      planItems: [
        { source: '/s/a.mkv', destination: '/d/a.mkv', skipped: true, unchanged: false },
        { source: '/s/b.nfo', destination: '/d/b.nfo', skipped: false, unchanged: true },
        { source: '/s/c.mkv', destination: '/d/c.mkv', skipped: false, unchanged: false },
      ],
    });
    await stages.get('imported')!.run(ctx);
    expect(executed.map((e) => e.destination)).toEqual(['/d/c.mkv']);
  });

  it('quarantines when the plan yields nothing to place', async () => {
    // Silently succeeding would mark an intake imported having moved nothing.
    const { stages } = build({ planItems: [] });
    expect((await stages.get('imported')!.run(ctx)).quarantine).toBeDefined();
  });

  it('records where the file landed', async () => {
    const { stages, updates } = build();
    await stages.get('imported')!.run(ctx);
    expect(updates.some((u) => u.importedPath === '/media/TV/Some Show/Some Show - S01E02.mkv')).toBe(true);
  });

  it('passes the recorded strategy through to the executor', async () => {
    // The plan stage already chose and persisted it; re-deciding here could
    // pick something different from what the timeline says was attempted.
    const { stages, executed } = build({ job: { id: 'j1', libraryId: 'lib-tv', strategy: 'copy' } });
    await stages.get('imported')!.run(ctx);
    expect(executed[0].requested).toBe('copy');
  });

  it('reports a fallback rather than hiding it', async () => {
    const { stages } = build({ outcome: { fellBack: true, strategy: 'copy' } });
    expect((await stages.get('imported')!.run(ctx)).message).toMatch(/fell back/);
  });

  it('marks importing as its own state before placing anything', async () => {
    /*
     * A process that dies mid-copy must leave `importing` behind — which reads
     * as "interrupted, check it" rather than `ready_to_import`, which reads as
     * "never started" and invites a second attempt on a half-copied file.
     */
    const { stages, executed } = build();
    const out = await stages.get('importing')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(executed).toHaveLength(0);
  });
});
