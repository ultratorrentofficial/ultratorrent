import { mkdtemp, mkdir, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { DiscoveryIntakeService } from './discovery-intake.service';

/**
 * Exercised against a REAL temporary filesystem rather than a mocked `fs`.
 *
 * The behaviours that matter here — an existing file where a directory should
 * go, a directory that exists but cannot be written into, `mkdir -p` being
 * idempotent — are all properties of the filesystem. Mocking them would test the
 * mock.
 */
describe('DiscoveryIntakeService', () => {
  let root: string;
  let svc: DiscoveryIntakeService;

  const filePathStub = (roots: string[]) =>
    ({
      assertWithinHardRoots: (p: string) => {
        if (!roots.some((r) => p === r || p.startsWith(`${r}/`))) {
          throw new ForbiddenException(`Path is outside the allowed storage roots (${roots.join(', ')}).`);
        }
        return p;
      },
    }) as any;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-discovery-'));
    svc = new DiscoveryIntakeService(filePathStub([root]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const provision = (tokens: any, template = 'TV Shows/{tvshow} ({year})', libraryPaths?: string[]) =>
    svc.provision({ stagingRoot: `${root}/staging`, pathTemplate: template, tokens, libraryPaths });

  it('creates the directory and reports it', async () => {
    const r = await provision({ tvshow: 'The Last of Us', year: 2023 });
    expect(r).toMatchObject({ ok: true, detail: 'created' });
    expect(r.path).toBe(`${root}/staging/TV Shows/The Last of Us (2023)`);
    expect((await stat(r.path!)).isDirectory()).toBe(true);
  });

  it('is idempotent — running again reports it existed and changes nothing', async () => {
    const first = await provision({ tvshow: 'Silo', year: 2023 });
    const second = await provision({ tvshow: 'Silo', year: 2023 });
    expect(first.detail).toBe('created');
    expect(second).toMatchObject({ ok: true, detail: 'existed', path: first.path });
  });

  /*
   * Removing it would be destroying somebody's data to make room for a folder.
   */
  it('refuses when a FILE already occupies the path, and does not delete it', async () => {
    await mkdir(`${root}/staging/Movies`, { recursive: true });
    const occupied = `${root}/staging/Movies/Rose of Nevada (2026)`;
    await writeFile(occupied, 'important');

    const r = await svc.provision({
      stagingRoot: `${root}/staging`,
      pathTemplate: 'Movies/{movie} ({year})',
      tokens: { movie: 'Rose of Nevada', year: 2026 },
    });

    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/A file already exists/);
    expect((await stat(occupied)).isFile()).toBe(true);
  });

  /*
   * The renderer proves the path is under the profile's staging root; this proves
   * the staging root is somewhere this installation may write at all. A profile
   * edited to point outside FILE_MANAGER_ROOTS passes the first and must fail the
   * second.
   */
  it('refuses a staging root outside the ops hard roots', async () => {
    const r = await svc.provision({
      stagingRoot: '/etc/ultratorrent-staging',
      pathTemplate: '{movie}',
      tokens: { movie: 'X' },
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/outside the allowed storage roots/);
  });

  it('refuses a path that would land inside a destination library', async () => {
    const r = await svc.provision({
      stagingRoot: `${root}/Movies/incoming`,
      pathTemplate: '{movie}',
      tokens: { movie: 'X' },
      libraryPaths: [`${root}/Movies`],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/inside the library/);
  });

  it('reports a title that renders to nothing rather than creating a blank folder', async () => {
    const r = await provision({ tvshow: '...', year: null }, '{tvshow}');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/rendered to nothing/);
  });

  it('sanitises a hostile title instead of escaping the root', async () => {
    const r = await provision({ tvshow: '../../etc/passwd', year: null }, '{tvshow}');
    expect(r.ok).toBe(true);
    expect(r.path).toBe(`${root}/staging/etc passwd`);
  });

  /*
   * A directory can exist and still be unusable — a parent with an unexpected
   * owner, a read-only remount. Surfacing it here means the failure is seen while
   * somebody is looking at the discovery, not at import time inside a sweep.
   */
  it('reports an existing directory it cannot write into', async () => {
    const target = `${root}/staging/TV Shows/Locked (2026)`;
    await mkdir(target, { recursive: true });
    await chmod(target, 0o500); // r-x: listable, not writable

    const r = await provision({ tvshow: 'Locked', year: 2026 });

    await chmod(target, 0o700); // restore so cleanup can remove it
    if (process.getuid?.() === 0) {
      // root ignores the permission bits entirely, so there is nothing to assert.
      expect(r.ok).toBe(true);
    } else {
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/not writable/);
    }
  });

  it('never reports success without a path', async () => {
    const ok = await provision({ tvshow: 'Fine', year: 2026 });
    expect(ok.ok && typeof ok.path === 'string').toBe(true);
  });

  it('creates intermediate directories', async () => {
    const r = await provision({ tvshow: 'Deep', year: 2026 }, 'a/b/c/{tvshow}');
    expect(r.ok).toBe(true);
    expect((await stat(`${root}/staging/a/b/c/Deep`)).isDirectory()).toBe(true);
  });
});
