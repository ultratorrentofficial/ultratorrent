import { mkdtemp, writeFile, rm, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaLinkageService } from './media-linkage.service';

/**
 * "Reclaimable bytes" is a promise, and for a hardlink import it was a false
 * one. The library file and the Intake payload are two names for one inode, so
 * deleting either frees NOTHING until the last name goes. Media Purge quoted
 * file size regardless, and so did I when I told an operator that 10.27 GB of
 * stranded payloads could be reclaimed — every one had nlink=2.
 */
const svc = (jobs: unknown[] = []) => new MediaLinkageService(
  { mediaIntakeJob: { findMany: jest.fn(async () => jobs) } } as never,
  { get: jest.fn() } as never,
);

describe('describePaths', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'linkage-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reports nothing freed while a second link survives', async () => {
    const a = path.join(dir, 'library.mkv');
    const b = path.join(dir, 'intake.mkv');
    await writeFile(a, 'x'.repeat(4096));
    await link(a, b);   // exactly what a hardlink import produces

    const [out] = await svc().describePaths([a]);

    expect(out.links).toBe(2);
    expect(out.sizeBytes).toBe(4096);
    expect(out.freesBytes).toBe(0);
  });

  it('reports the full size once it is the only link', async () => {
    const only = path.join(dir, 'only.mkv');
    await writeFile(only, 'x'.repeat(2048));

    const [out] = await svc().describePaths([only]);

    expect(out.links).toBe(1);
    expect(out.freesBytes).toBe(2048);
  });

  it('counts a directory by what its files would actually free', async () => {
    const folder = path.join(dir, 'release');
    await mkdir(folder);
    const shared = path.join(folder, 'film.mkv');
    await writeFile(shared, 'x'.repeat(1000));
    await link(shared, path.join(dir, 'elsewhere.mkv'));   // also in the library
    await writeFile(path.join(folder, 'notes.nfo'), 'y'.repeat(50));

    const [out] = await svc().describePaths([folder]);

    expect(out.sizeBytes).toBe(1050);
    expect(out.freesBytes).toBe(50);   // only the nfo is unique to this folder
  });

  it('does not claim anything for a path that is gone', async () => {
    const [out] = await svc().describePaths([path.join(dir, 'missing.mkv')]);
    expect(out).toMatchObject({ exists: false, sizeBytes: 0, freesBytes: 0 });
  });
});

describe('torrentsForPaths', () => {
  it('matches a payload, a file inside it, and a parent that contains it', async () => {
    const job = { torrentHash: 'h1', engineId: 'e1', state: 'seeding', mediaItemId: 'i1',
      sourcePath: '/downloads/Intake/Movies/Film (2026)' };

    const exact = await svc([job]).torrentsForPaths(['/downloads/Intake/Movies/Film (2026)']);
    const inside = await svc([job]).torrentsForPaths(['/downloads/Intake/Movies/Film (2026)/film.mkv']);
    const parent = await svc([job]).torrentsForPaths(['/downloads/Intake/Movies']);
    const unrelated = await svc([job]).torrentsForPaths(['/downloads/Movies/Other (2026)']);

    expect(exact).toHaveLength(1);
    expect(inside).toHaveLength(1);   // deleting the file guts the payload
    expect(parent).toHaveLength(1);   // deleting the parent takes it too
    expect(unrelated).toHaveLength(0);
    // A sibling whose name merely starts the same must not match.
    expect(await svc([job]).torrentsForPaths(['/downloads/Intake/Movies/Film (2026) EXTRAS'])).toHaveLength(0);
  });

  it('groups a pack so its bytes are not counted once per episode', async () => {
    const rows = ['i1', 'i2', 'i3'].map((id) => ({
      torrentHash: 'pack', engineId: 'e1', state: 'seeding', mediaItemId: id,
      sourcePath: '/downloads/Intake/TV/Show S01',
    }));
    const out = await svc(rows).torrentsForItems(['i1', 'i2', 'i3']);
    expect(out).toHaveLength(1);
    expect(out[0].itemIds.sort()).toEqual(['i1', 'i2', 'i3']);
  });
});
