/**
 * The post-import stages.
 *
 * One rule governs all of them: the file is already in the library and usable,
 * so an enrichment outage must never fail the intake. The only thing that
 * quarantines here is a real mismatch — something placed on disk that the
 * library refuses to take.
 */
import { IntakePostImportService } from './intake-post-import.service';
import type { IntakeStage, StageContext } from './intake-pipeline.service';

function build(over: {
  job?: Record<string, unknown> | null;
  item?: Record<string, unknown> | null;
  itemAfterScan?: Record<string, unknown> | null;
  metadataThrows?: boolean;
  artworkThrows?: boolean;
  refreshThrows?: boolean;
} = {}) {
  const stages = new Map<string, IntakeStage>();
  const updates: Record<string, unknown>[] = [];
  const scans: Array<{ libraryId: string; subPath?: string }> = [];
  let findCall = 0;

  const prisma = {
    mediaIntakeJob: {
      findUnique: jest.fn(async () => over.job === undefined
        ? { id: 'j1', importedPath: '/media/TV/Show/ep.mkv', libraryId: 'lib-1', mediaItemId: 'item-1' }
        : over.job),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => { updates.push(a.data); return {}; }),
    },
    mediaItem: {
      findFirst: jest.fn(async () => {
        findCall += 1;
        // First call is before the scan, second is after it.
        if (findCall === 1) return over.item === undefined ? { id: 'item-1', title: 'Ep' } : over.item;
        return over.itemAfterScan === undefined ? { id: 'item-1', title: 'Ep' } : over.itemAfterScan;
      }),
    },
  };
  const scanner = {
    scanLibrary: jest.fn(async (libraryId: string, _r: unknown, subPath?: string) => {
      scans.push({ libraryId, subPath });
      return {};
    }),
  };
  const metadata = {
    fetchMetadata: jest.fn(async () => {
      if (over.metadataThrows) throw new Error('provider 503');
      return {};
    }),
  };
  const artwork = {
    importFromProvider: jest.fn(async () => {
      if (over.artworkThrows) throw new Error('no artwork found');
      return {};
    }),
  };
  const subtitles = { scan: jest.fn(async () => ({})) };
  const integrations = {
    refreshAllEnabled: jest.fn(async () => {
      if (over.refreshThrows) throw new Error('plex unreachable');
      return { refreshed: 2, failed: 0 };
    }),
  };
  const pipeline = { register: jest.fn((s: IntakeStage) => stages.set(s.produces, s)) };

  const svc = new IntakePostImportService(
    prisma as never, pipeline as never, scanner as never, metadata as never,
    artwork as never, subtitles as never, integrations as never,
  );
  jest.spyOn((svc as never as { logger: { debug: (m: string) => void } }).logger, 'debug')
    .mockImplementation(() => undefined);
  svc.onModuleInit();
  return { svc, stages, updates, scans, metadata, artwork, subtitles, integrations, scanner };
}

const ctx: StageContext = {
  jobId: 'j1', sourcePath: '/staging/ep.mkv', profileId: 'p1',
  torrentHash: 'abc', engineId: 'e1',
};

describe('resolving the item', () => {
  it('registers the four post-import stages', () => {
    const { stages } = build();
    expect([...stages.keys()]).toEqual([
      'metadata_ready', 'artwork_ready', 'subtitle_ready', 'seeding',
    ]);
  });

  it('does not scan when the item already exists', async () => {
    // The periodic scanner may have taken it between the import and this stage;
    // scanning again is work for nothing.
    const { stages, scans } = build();
    await stages.get('metadata_ready')!.run(ctx);
    expect(scans).toHaveLength(0);
  });

  it('scans ONLY the imported folder when the item is missing', async () => {
    /*
     * A full library rescan per import turns a batch of twenty episodes into
     * twenty sweeps of a 22 TB tree — the kind of cost that gets a feature
     * switched off rather than fixed.
     */
    const { stages, scans } = build({ item: null });
    await stages.get('metadata_ready')!.run(ctx);
    expect(scans).toEqual([{ libraryId: 'lib-1', subPath: '/media/TV/Show' }]);
  });

  it('records the resolved item on the job', async () => {
    const { stages, updates } = build();
    await stages.get('metadata_ready')!.run(ctx);
    expect(updates[0]).toMatchObject({ mediaItemId: 'item-1' });
  });

  it('QUARANTINES when the scan will not take a file that is on disk', async () => {
    /*
     * A mismatch between what intake placed and what the library accepts — an
     * extension outside its filter, a permission problem. That needs a person,
     * not a retry.
     */
    const { stages } = build({ item: null, itemAfterScan: null });
    const out = await stages.get('metadata_ready')!.run(ctx);
    expect(out.quarantine?.reason).toMatch(/did not pick it up/);
  });

  it('quarantines when nothing was recorded as imported', async () => {
    const { stages } = build({ job: { id: 'j1', importedPath: null, libraryId: 'lib-1' } });
    expect((await stages.get('metadata_ready')!.run(ctx)).quarantine).toBeDefined();
  });
});

describe('enrichment never fails the intake', () => {
  it('carries on when the metadata provider is down', async () => {
    /*
     * The file is already in the library and playable. Failing the intake here
     * would say otherwise, and a provider outage is not a reason to hold media
     * back from someone who already has it on disk.
     */
    const { stages } = build({ metadataThrows: true });
    const out = await stages.get('metadata_ready')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(out.message).toMatch(/metadata unavailable/);
    expect(out.data).toMatchObject({ metadataFailed: true });
  });

  it('carries on when artwork cannot be found', async () => {
    const { stages } = build({ artworkThrows: true });
    const out = await stages.get('artwork_ready')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(out.message).toMatch(/unavailable/);
  });

  it('runs artwork and subtitles against the resolved item', async () => {
    const { stages, artwork, subtitles } = build();
    await stages.get('artwork_ready')!.run(ctx);
    await stages.get('subtitle_ready')!.run(ctx);
    expect(artwork.importFromProvider).toHaveBeenCalledWith('item-1', {});
    expect(subtitles.scan).toHaveBeenCalledWith('item-1');
  });

  it('skips enrichment rather than crashing when no item was resolved', async () => {
    const { stages, artwork } = build({ job: { id: 'j1', mediaItemId: null } });
    const out = await stages.get('artwork_ready')!.run(ctx);
    expect(artwork.importFromProvider).not.toHaveBeenCalled();
    expect(out.message).toMatch(/skipped/);
  });
});

describe('media server notification', () => {
  it('refreshes only at the end, once everything is in place', async () => {
    /*
     * Refreshing earlier means Plex indexes a bare file and the operator
     * watches an untitled entry appear and then change under them.
     */
    const { stages, integrations } = build();
    const out = await stages.get('seeding')!.run(ctx);
    expect(integrations.refreshAllEnabled).toHaveBeenCalled();
    expect(out.message).toMatch(/Refreshed 2/);
  });

  it('does not undo an import because a media server was unreachable', async () => {
    const { stages } = build({ refreshThrows: true });
    const out = await stages.get('seeding')!.run(ctx);
    expect(out.quarantine).toBeUndefined();
    expect(out.message).toMatch(/refresh failed/);
  });
});
