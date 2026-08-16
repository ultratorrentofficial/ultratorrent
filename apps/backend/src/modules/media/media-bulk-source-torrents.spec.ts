import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaBulkService } from './media-bulk.service';

/**
 * Deleting a library item said nothing about where the media came from.
 *
 * For a hardlink import the library copy is one of two links: unlinking it
 * leaves the Intake payload and a still-seeding torrent with nothing pointing
 * at them. One live host had stranded 29 imports that way, 6 of whose payloads
 * were still on disk holding 10.3 GB — including a film whose whole lifecycle
 * (RSS match → download → import → metadata → artwork) had completed an hour
 * before an operator bulk-deleted it.
 *
 * These cover the preflight the confirmation dialog uses.
 */
function buildService(jobs: unknown[]) {
  const prisma = {
    mediaIntakeJob: { findMany: jest.fn(async () => jobs) },
    mediaItem: { findMany: jest.fn(async () => []), delete: jest.fn() },
  };
  return new MediaBulkService(
    prisma as never,
    { runDetached: jest.fn() } as never,
    { record: jest.fn() } as never,
    { get: jest.fn() } as never,
  );
}

describe('sourceTorrents', () => {
  let root: string;

  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'src-torrents-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports the torrent behind a selection, with the bytes it would strand', async () => {
    const payload = path.join(root, 'A Film (2026) [1080p]');
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, 'film.mp4'), 'x'.repeat(2048));
    await mkdir(path.join(payload, 'Subs'), { recursive: true });
    await writeFile(path.join(payload, 'Subs', 'en.srt'), 'y'.repeat(512));

    const svc = buildService([
      { torrentHash: 'abc', engineId: 'e1', sourcePath: payload, mediaItemId: 'i1', state: 'seeding' },
    ]);

    const out = await svc.sourceTorrents(['i1']);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      torrentHash: 'abc', engineId: 'e1', state: 'seeding', itemIds: ['i1'],
      name: 'A Film (2026) [1080p]',
    });
    // Measured on disk, recursively — the figure the dialog promises.
    expect(out[0].sizeBytes).toBe(2560);
  });

  it('groups a pack so its bytes are not counted once per episode', async () => {
    const payload = path.join(root, 'A Show S01 PACK');
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, 'e01.mkv'), 'x'.repeat(1000));

    const svc = buildService([
      { torrentHash: 'pack', engineId: 'e1', sourcePath: payload, mediaItemId: 'i1', state: 'seeding' },
      { torrentHash: 'pack', engineId: 'e1', sourcePath: payload, mediaItemId: 'i2', state: 'seeding' },
      { torrentHash: 'pack', engineId: 'e1', sourcePath: payload, mediaItemId: 'i3', state: 'seeding' },
    ]);

    const out = await svc.sourceTorrents(['i1', 'i2', 'i3']);

    expect(out).toHaveLength(1);
    expect(out[0].itemIds.sort()).toEqual(['i1', 'i2', 'i3']);
    expect(out[0].sizeBytes).toBe(1000);
  });

  it('reports zero bytes for a payload that is already gone', async () => {
    // The job outlives the payload; the dialog must not promise bytes that
    // cannot be reclaimed.
    const svc = buildService([
      { torrentHash: 'x', engineId: null, sourcePath: path.join(root, 'missing'), mediaItemId: 'i1', state: 'seeding' },
    ]);

    const out = await svc.sourceTorrents(['i1']);

    expect(out[0].sizeBytes).toBe(0);
  });

  it('returns nothing when the selection came from no torrent', async () => {
    const svc = buildService([]);
    expect(await svc.sourceTorrents(['i1', 'i2'])).toEqual([]);
  });

  it('returns nothing for an empty selection without querying', async () => {
    const svc = buildService([]);
    expect(await svc.sourceTorrents([])).toEqual([]);
  });
});
