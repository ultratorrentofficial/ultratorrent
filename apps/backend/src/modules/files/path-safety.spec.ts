import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PathSafety, assertSafeName } from './path-safety';

describe('PathSafety', () => {
  const safety = new PathSafety(['/downloads', '/media']);

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

  describe('assertDeletable', () => {
    it('refuses to delete a configured storage root', () => {
      expect(() => safety.assertDeletable('/downloads')).toThrow(ForbiddenException);
      expect(() => safety.assertDeletable('/media')).toThrow(ForbiddenException);
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
    it('produces a root-relative path', () => {
      expect(safety.toRelative('/downloads/movies/a.mkv')).toBe('/movies/a.mkv');
      expect(safety.toRelative('/media')).toBe('/');
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
