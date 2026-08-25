import { describe, expect, it } from 'vitest';
import { absoluteToWire, crumbsFor, rootFor, usesAbsolutePaths, wireToAbsolute } from './file-path';

const ONE = ['/downloads'];
const TWO = ['/downloads', '/media/orico'];

describe('file-path — single root', () => {
  it('treats wire paths as root-relative', () => {
    expect(usesAbsolutePaths(ONE)).toBe(false);
    expect(wireToAbsolute(ONE, '/Movies/a.mkv')).toBe('/downloads/Movies/a.mkv');
    expect(wireToAbsolute(ONE, '/')).toBe('/downloads');
    expect(absoluteToWire(ONE, '/downloads/Movies')).toBe('/Movies');
    expect(absoluteToWire(ONE, '/downloads')).toBe('/');
  });

  it('opens at the top for a path outside the root', () => {
    expect(absoluteToWire(ONE, '/elsewhere/Movies')).toBe('/');
    expect(absoluteToWire(ONE, undefined)).toBe('/');
  });

  it('builds crumbs from the relative segments', () => {
    expect(crumbsFor(ONE, '/Movies/HD')).toEqual([
      { label: 'Movies', path: '/Movies' },
      { label: 'HD', path: '/Movies/HD' },
    ]);
  });
});

describe('file-path — several roots', () => {
  it('treats wire paths as absolute', () => {
    expect(usesAbsolutePaths(TWO)).toBe(true);
    expect(wireToAbsolute(TWO, '/media/orico/TV Retro')).toBe('/media/orico/TV Retro');
    expect(absoluteToWire(TWO, '/media/orico/TV Retro')).toBe('/media/orico/TV Retro');
    expect(rootFor(TWO, '/media/orico/TV Retro')).toBe('/media/orico');
  });

  /*
   * The whole point of the absolute form: `/TV Retro` alone cannot say which
   * root it belongs to, and guessing roots[0] is what made the second root
   * unreachable in the first place.
   */
  it('keeps same-named folders in different roots distinct', () => {
    expect(absoluteToWire(TWO, '/downloads/Shared')).not.toEqual(
      absoluteToWire(TWO, '/media/orico/Shared'),
    );
  });

  it('starts crumbs at the containing root, never above it', () => {
    expect(crumbsFor(TWO, '/media/orico/TV Retro/S01')).toEqual([
      { label: 'orico', path: '/media/orico' },
      { label: 'TV Retro', path: '/media/orico/TV Retro' },
      { label: 'S01', path: '/media/orico/TV Retro/S01' },
    ]);
    // `/mnt` or `/media` must never appear as a crumb — they are outside the
    // boundary and would only 403 when clicked.
    expect(crumbsFor(TWO, '/media/orico').map((c) => c.path)).toEqual(['/media/orico']);
  });

  it('has no crumbs at the virtual root, and no absolute form for it', () => {
    expect(crumbsFor(TWO, '/')).toEqual([]);
    expect(wireToAbsolute(TWO, '/')).toBe('');
  });

  it('opens at the virtual root for a path outside every root', () => {
    expect(absoluteToWire(TWO, '/etc/passwd')).toBe('/');
  });
});
