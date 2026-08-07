import { libraryForPath } from './library-scope';

/**
 * Which library a torrent belongs to.
 *
 * A `library`-scoped policy matches on this, and until now nothing populated
 * it: `matches()` requires `ctx.libraryId`, the preview never set it, so the
 * scope appeared in the editor, saved happily, and then governed no torrent at
 * all. A policy that cannot apply is worse than one the UI refuses to create,
 * because nothing tells the operator it is inert.
 */
const LIBS = [
  { id: 'movies', path: '/downloads/Movies' },
  { id: 'hd', path: '/downloads/Movies/HD Movies' },
  { id: 'tv', path: '/downloads/TV Shows' },
];

describe('resolving a library from a save path', () => {
  it('finds the library whose root contains the file', () => {
    expect(libraryForPath('/downloads/TV Shows/Silo (2023)/Season 3', LIBS)).toBe('tv');
  });

  it('matches a path that IS the library root', () => {
    expect(libraryForPath('/downloads/TV Shows', LIBS)).toBe('tv');
  });

  it('prefers the most specific root when libraries nest', () => {
    /*
     * The case this platform actually has: the libraries live inside the
     * download tree and nest, so a film under "HD Movies" is covered by
     * "Movies" too. Returning the shallower one would let a policy written for
     * Movies silently capture a torrent the operator files under HD Movies —
     * exactly the confusion that scope precedence exists to prevent.
     */
    expect(libraryForPath('/downloads/Movies/HD Movies/Dune (2021)', LIBS)).toBe('hd');
  });

  it('returns null when nothing covers the path', () => {
    // Not a guess and not an error: the torrent simply inherits from the scope
    // above, which is the correct meaning of "no library policy applies".
    expect(libraryForPath('/downloads/Intake/Movies/Something', LIBS)).toBeNull();
  });

  it('returns null for a missing or empty path', () => {
    expect(libraryForPath(null, LIBS)).toBeNull();
    expect(libraryForPath(undefined, LIBS)).toBeNull();
    expect(libraryForPath('', LIBS)).toBeNull();
  });

  it('is not fooled by a sibling whose name starts the same way', () => {
    // A plain string prefix test would match "/downloads/Movies Archive"
    // against "/downloads/Movies". Containment is by path segment.
    expect(libraryForPath('/downloads/Movies Archive/Old', LIBS)).toBeNull();
  });

  it('does not escape upward', () => {
    expect(libraryForPath('/downloads', LIBS)).toBeNull();
    expect(libraryForPath('/', LIBS)).toBeNull();
  });

  it('normalises a path with redundant segments', () => {
    expect(libraryForPath('/downloads/Movies/../Movies/HD Movies/x', LIBS)).toBe('hd');
  });

  it('ignores a library with no path configured', () => {
    const libs = [{ id: 'broken', path: '' }, ...LIBS];
    expect(libraryForPath('/downloads/TV Shows/x', libs)).toBe('tv');
  });

  it('returns null when there are no libraries at all', () => {
    expect(libraryForPath('/downloads/Movies/x', [])).toBeNull();
  });
});
