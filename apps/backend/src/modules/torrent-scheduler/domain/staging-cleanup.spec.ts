import { isWithinRoot, planStagingCleanup } from './staging-cleanup';

/**
 * The deletion boundary. Every case here is a way the library could be destroyed
 * if containment were tested loosely.
 */
const STAGING = ['/data/downloads/complete', '/data/downloads/temp'];
const LIBRARY = ['/data/media/TV', '/data/media/Movies'];

const plan = (paths: string[]) =>
  planStagingCleanup({ paths, stagingRoots: STAGING, libraryRoots: LIBRARY });

describe('isWithinRoot', () => {
  it('matches the root itself and anything beneath it', () => {
    expect(isWithinRoot('/data/media/TV', '/data/media/TV')).toBe(true);
    expect(isWithinRoot('/data/media/TV/Show/ep.mkv', '/data/media/TV')).toBe(true);
  });

  it('does not match a sibling whose name merely starts the same', () => {
    // A plain prefix test says true here, and would delete out of the wrong tree.
    expect(isWithinRoot('/data/media/TV2/ep.mkv', '/data/media/TV')).toBe(false);
    expect(isWithinRoot('/data/media/TVShows/ep.mkv', '/data/media/TV')).toBe(false);
  });

  it('ignores a trailing separator and case on the root', () => {
    expect(isWithinRoot('/data/media/TV/ep.mkv', '/data/media/TV/')).toBe(true);
    expect(isWithinRoot('/DATA/Media/tv/ep.mkv', '/data/media/TV')).toBe(true);
  });

  it('is false for empty inputs rather than matching everything', () => {
    expect(isWithinRoot('/data/media/TV/ep.mkv', '')).toBe(false);
    expect(isWithinRoot('', '/data/media/TV')).toBe(false);
  });
});

describe('planStagingCleanup', () => {
  it('deletes files under a staging root', () => {
    const out = plan(['/data/downloads/complete/Show.S01E01/ep.mkv']);
    expect(out.deletable).toEqual(['/data/downloads/complete/Show.S01E01/ep.mkv']);
    expect(out.kept).toEqual([]);
  });

  it('never deletes a file that lives in a library', () => {
    // The `move` and `provider_relocation` case: the torrent's only copy IS the
    // library's copy, and deleting it destroys the media.
    const out = plan(['/data/media/TV/Show/Season 1/ep.mkv']);
    expect(out.deletable).toEqual([]);
    expect(out.kept).toEqual([{ path: '/data/media/TV/Show/Season 1/ep.mkv', reason: 'in_library' }]);
  });

  it('keeps a file that is under neither root', () => {
    // An unrecognised location is not evidence that a file is disposable.
    const out = plan(['/mnt/elsewhere/ep.mkv']);
    expect(out.deletable).toEqual([]);
    expect(out.kept).toEqual([{ path: '/mnt/elsewhere/ep.mkv', reason: 'outside_staging' }]);
  });

  it('splits a torrent that straddles both', () => {
    const out = plan([
      '/data/downloads/complete/pack/ep1.mkv',
      '/data/media/TV/Show/Season 1/ep1.mkv',
      '/data/downloads/temp/pack/ep2.mkv',
    ]);
    expect(out.deletable).toEqual([
      '/data/downloads/complete/pack/ep1.mkv',
      '/data/downloads/temp/pack/ep2.mkv',
    ]);
    expect(out.kept.map((k) => k.reason)).toEqual(['in_library']);
  });

  it('resolves a root that is BOTH staging and library as keep', () => {
    /*
     * A misconfiguration an operator can genuinely produce — a library pointed
     * at the download directory, which is how this platform is laid out on one
     * host. Library containment has to win, or the safety rule inverts precisely
     * where it matters most.
     */
    const out = planStagingCleanup({
      paths: ['/data/downloads/complete/Show/ep.mkv'],
      stagingRoots: ['/data/downloads/complete'],
      libraryRoots: ['/data/downloads/complete'],
    });
    expect(out.deletable).toEqual([]);
    expect(out.kept[0].reason).toBe('in_library');
  });

  it('deletes nothing when no staging root is configured', () => {
    const out = planStagingCleanup({
      paths: ['/data/downloads/complete/Show/ep.mkv'],
      stagingRoots: [],
      libraryRoots: LIBRARY,
    });
    expect(out.deletable).toEqual([]);
  });

  it('ignores empty paths instead of treating them as a root match', () => {
    const out = plan(['', '/data/downloads/complete/ep.mkv']);
    expect(out.deletable).toEqual(['/data/downloads/complete/ep.mkv']);
    expect(out.kept).toEqual([]);
  });
});
