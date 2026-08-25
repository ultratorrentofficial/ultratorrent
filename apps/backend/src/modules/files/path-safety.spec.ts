import { ForbiddenException, BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
import { PathSafety, assertSafeName } from './path-safety';

describe('PathSafety', () => {
  /*
   * The single-root case, which is what a stock deployment runs and what the
   * root-relative wire format is built for. These expectations are unchanged by
   * multi-root support on purpose: every existing install, and every trash
   * `originalPath` already on disk, speaks this dialect.
   */
  const safety = new PathSafety(['/downloads']);

  it('resolves a path inside a root', () => {
    expect(safety.resolveLogical('movies/film.mkv')).toBe(
      '/downloads/movies/film.mkv',
    );
  });

  it('blocks parent-directory traversal', () => {
    expect(() => safety.resolveLogical('../etc/passwd')).toThrow(
      ForbiddenException,
    );
  });

  it('sandboxes absolute-looking paths into the root (no escape)', () => {
    // A leading slash is stripped and re-based under the root, so it can never
    // reach a real system path like /etc/shadow.
    expect(safety.resolveLogical('/etc/shadow')).toBe('/downloads/etc/shadow');
  });

  it('blocks traversal that climbs above the root from a subpath', () => {
    expect(() => safety.resolveLogical('movies/../../etc/shadow')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects null bytes', () => {
    expect(() => safety.resolveLogical('a\0b')).toThrow(BadRequestException);
  });

  it('allows the root itself', () => {
    expect(safety.resolveLogical('')).toBe('/downloads');
  });

  /*
   * Several roots. The root-relative form is ambiguous here — `/TV Shows` names
   * a directory under each root — so clients address files absolutely. Rebasing
   * every request onto roots[0] (what this class used to do) did not resolve
   * that ambiguity, it hid it: the second root was unreachable, and a name
   * present in both silently served the first root's copy.
   */
  describe('with several roots', () => {
    const multi = new PathSafety(['/downloads', '/media/orico']);

    it('reports that clients must use absolute paths', () => {
      expect(multi.usesAbsolutePaths).toBe(true);
      expect(safety.usesAbsolutePaths).toBe(false);
    });

    it('resolves an absolute path in ANY root, not just the first', () => {
      expect(multi.resolveLogical('/media/orico/TV Retro')).toBe('/media/orico/TV Retro');
      expect(multi.resolveLogical('/downloads/Movies')).toBe('/downloads/Movies');
    });

    // The live failure: a folder that exists only in the second root was
    // rebased to /downloads/TV Retro and blew up with ENOENT as a 500.
    it('does not rebase a second-root path onto the first root', () => {
      expect(multi.resolveLogical('/media/orico/TV Retro')).not.toContain('/downloads');
    });

    it('still refuses anything no root contains', () => {
      for (const bad of ['/etc/shadow', '/media', '/', '', '/downloads/../etc']) {
        expect(() => multi.resolveLogical(bad)).toThrow(ForbiddenException);
      }
    });

    it('rejects null bytes', () => {
      expect(() => multi.resolveLogical('a\0b')).toThrow(BadRequestException);
    });

    it('round-trips: toRelative output is accepted by resolveLogical', () => {
      for (const abs of ['/media/orico/TV Retro/S01/e1.mkv', '/downloads/Movies', '/downloads']) {
        expect(multi.resolveLogical(multi.toRelative(abs))).toBe(abs);
      }
    });
  });

  describe('assertDeletable', () => {
    it('refuses to delete a configured storage root', () => {
      expect(() => safety.assertDeletable('/downloads')).toThrow(ForbiddenException);
      const multi = new PathSafety(['/downloads', '/media/orico']);
      expect(() => multi.assertDeletable('/media/orico')).toThrow(ForbiddenException);
    });

    it('refuses the filesystem root', () => {
      expect(() => safety.assertDeletable('/')).toThrow(ForbiddenException);
    });

    it('refuses known system directories', () => {
      expect(() => safety.assertDeletable('/etc')).toThrow(ForbiddenException);
      expect(() => safety.assertDeletable('/usr')).toThrow(ForbiddenException);
    });

    it('allows a normal item inside a root', () => {
      expect(() => safety.assertDeletable('/downloads/movies/film.mkv')).not.toThrow();
    });
  });

  describe('isInsideTrash', () => {
    it('detects the per-root trash directory', () => {
      expect(safety.isInsideTrash('/downloads/.ultratorrent-trash/x')).toBe(true);
      expect(safety.isInsideTrash('/downloads/movies/x')).toBe(false);
    });
  });

  describe('toRelative', () => {
    it('produces a root-relative path under a single root', () => {
      expect(safety.toRelative('/downloads/movies/a.mkv')).toBe('/movies/a.mkv');
      expect(safety.toRelative('/downloads')).toBe('/');
    });

    // Relative would be ambiguous across roots, so the absolute path IS the
    // client-facing form here.
    it('produces an absolute path when there are several roots', () => {
      const multi = new PathSafety(['/downloads', '/media/orico']);
      expect(multi.toRelative('/media/orico/TV Retro')).toBe('/media/orico/TV Retro');
      expect(multi.toRelative('/downloads/movies/a.mkv')).toBe('/downloads/movies/a.mkv');
    });

    // It used to rebase an uncontained path against roots[0], yielding a string
    // like "/../TV/show.mkv" that looked relative, passed through call after
    // call, and only blew up when something resolved it back — surfacing the
    // boundary error nowhere near the code that got the root wrong.
    it('refuses a path no root contains rather than emitting a `..` escape', () => {
      const narrowed = new PathSafety(['/downloads/complete']);
      expect(() => narrowed.toRelative('/downloads/TV/show.mkv')).toThrow(
        ForbiddenException,
      );
    });
  });

  /*
   * Trash/quarantine store this and rebase it onto the root they recorded, so
   * it must NOT follow the client-facing form. When `toRelative` went absolute
   * under several roots, storing that would have restored files to
   * `<root>/<root>/…` — silently, into a path nothing else refers to.
   */
  describe('relativeToRoot', () => {
    const multi = new PathSafety(['/downloads', '/media/orico']);

    it('stays root-relative however many roots exist', () => {
      expect(multi.relativeToRoot('/media/orico', '/media/orico/TV Retro/a.mkv')).toBe('/TV Retro/a.mkv');
      expect(safety.relativeToRoot('/downloads', '/downloads/Movies/a.mkv')).toBe('/Movies/a.mkv');
      expect(multi.relativeToRoot('/downloads', '/downloads')).toBe('/');
    });

    it('round-trips the way restore rebases it', () => {
      const root = '/media/orico';
      const abs = '/media/orico/TV Retro/S01/a.mkv';
      const stored = multi.relativeToRoot(root, abs);
      expect(path.resolve(root, stored.replace(/^\/+/, ''))).toBe(abs);
    });

    it('refuses a path the given root does not contain', () => {
      expect(() => multi.relativeToRoot('/media/orico', '/downloads/a.mkv')).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('assertSafeName', () => {
    it('rejects separators, traversal, and empties', () => {
      for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
        expect(() => assertSafeName(bad)).toThrow(BadRequestException);
      }
    });
    it('accepts ordinary names', () => {
      expect(() => assertSafeName('Season 01')).not.toThrow();
    });
  });
});
