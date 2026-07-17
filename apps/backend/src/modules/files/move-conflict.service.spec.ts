import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FilePathService } from './file-path.service';
import { MoveConflictService } from './move-conflict.service';

function settingsDouble() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (k: string) => store.get(k)),
    set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    getAll: jest.fn(async () => Object.fromEntries(store)),
  };
}
const configDouble = (roots: string[]) =>
  ({ get: (k: string) => (k === 'fileManager.roots' ? roots : undefined) }) as any;

/** Write `size` bytes filled with `byte` — lets us forge same-size / different-content pairs. */
function writeSized(abs: string, size: number, byte = 0): void {
  writeFileSync(abs, Buffer.alloc(size, byte));
}

describe('MoveConflictService', () => {
  let root: string;
  let src: string; // incoming staging dir
  let dst: string; // destination "show folder"
  let svc: MoveConflictService;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'ut-conflict-'));
    src = path.join(root, 'downloads');
    dst = path.join(root, 'show');
    mkdirSync(src);
    mkdirSync(dst);
    const paths = new FilePathService(configDouble([root]), settingsDouble() as any);
    await paths.refresh();
    svc = new MoveConflictService(paths);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const rel = (abs: string) => '/' + path.relative(root, abs).split(path.sep).join('/');

  it('reports a source with nothing in its way as clean', async () => {
    const s = path.join(src, 'Alone.S01E09.1080p.WEB.x265-GRP.mkv');
    writeSized(s, 1024);
    const report = await svc.analyze([rel(s)], rel(dst));
    expect(report.conflicts).toHaveLength(0);
    expect(report.clean).toEqual([rel(s)]);
  });

  it('flags byte-identical content as identical and recommends deleting the source', async () => {
    const name = 'Show.S02E01.1080p.WEB.x265-GRP.mkv';
    const s = path.join(src, name);
    const t = path.join(dst, name);
    writeSized(s, 4096, 7);
    writeSized(t, 4096, 7); // same size, same bytes
    const report = await svc.analyze([rel(s)], rel(dst));

    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0];
    expect(c.kind).toBe('identical');
    expect(c.identityBasis).toBe('size+partial-hash');
    expect(c.recommended).toBe('delete_source');
    // keep_both makes no sense for identical bytes.
    expect(c.allowed).not.toContain('keep_both');
  });

  it('does NOT call same-size-but-different content identical', async () => {
    const name = 'Show.S02E02.1080p.WEB.x265-GRP.mkv';
    const s = path.join(src, name);
    const t = path.join(dst, name);
    writeSized(s, 4096, 1);
    writeSized(t, 4096, 2); // same size, different bytes
    const report = await svc.analyze([rel(s)], rel(dst));

    expect(report.conflicts).toHaveLength(1);
    // Same filename, same size, but the content differs — a name clash, never identical.
    expect(report.conflicts[0].kind).not.toBe('identical');
    expect(report.conflicts[0].identityBasis).toBeUndefined();
  });

  it('detects the same episode under a different release name and judges quality', async () => {
    // Different release of the same episode — different name, so only episode
    // identity ties them together.
    const s = path.join(src, 'Gangs.of.London.S03E05.1080p.HEVC.x265-MeGusta.mkv');
    const t = path.join(dst, 'Gangs.of.London.S03E05.720p.HDTV.x264-OLD.mkv');
    writeSized(s, 2048);
    writeSized(t, 1024);
    const report = await svc.analyze([rel(s)], rel(dst));

    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0];
    expect(c.kind).toBe('same_episode');
    expect(c.verdict).toBe('source_better'); // 1080p > 720p
    expect(c.verdictReasons.join(' ')).toMatch(/1080p/);
    expect(c.recommended).toBe('replace');
  });

  it('recommends keeping the target when it is the better release', async () => {
    const s = path.join(src, 'Gangs.of.London.S03E06.720p.HDTV.x264-OLD.mkv');
    const t = path.join(dst, 'Gangs.of.London.S03E06.2160p.WEB.x265-GRP.mkv');
    writeSized(s, 2048);
    writeSized(t, 1024);
    const report = await svc.analyze([rel(s)], rel(dst));

    const c = report.conflicts[0];
    expect(c.kind).toBe('same_episode');
    expect(c.verdict).toBe('target_better'); // 2160p > 720p
    expect(c.recommended).toBe('delete_source');
  });

  it('treats an unparseable same-name file as a name clash and defaults to skip', async () => {
    const name = 'random-notes.txt';
    const s = path.join(src, name);
    const t = path.join(dst, name);
    writeSized(s, 10, 1);
    writeSized(t, 20, 2); // different size → not identical
    const report = await svc.analyze([rel(s)], rel(dst));

    const c = report.conflicts[0];
    expect(c.kind).toBe('name_clash');
    // Nothing can be inferred, so nothing destructive is pre-selected.
    expect(c.recommended).toBe('skip');
    expect(c.allowed).toEqual(['replace', 'keep_both', 'delete_source', 'skip']);
  });
});
