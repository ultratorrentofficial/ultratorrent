import { BadRequestException } from '@nestjs/common';
import { renderPathFragment, renderTargetPath } from './discovery-path';

const ROOT = '/media/Staging';
const render = (pathTemplate: string, tokens: any, libraryPaths?: string[]) =>
  renderTargetPath({ stagingRoot: ROOT, pathTemplate, tokens, libraryPaths });

describe('rendering the leaf', () => {
  it('renders the documented TV shape', () => {
    expect(render('TV Shows/{tvshow} ({year})', { tvshow: 'The Last of Us', year: 2023 })).toBe(
      '/media/Staging/TV Shows/The Last of Us (2023)',
    );
  });

  it('renders the documented movie shape', () => {
    expect(render('Movies/{movie} ({year})', { movie: 'Rose of Nevada', year: 2026 })).toBe(
      '/media/Staging/Movies/Rose of Nevada (2026)',
    );
  });

  /*
   * A discovery-created folder and a renamer-created one must not differ by a
   * leading zero, or the library ends up with `Season 1` beside `Season 01`.
   */
  it('pads a season number to two digits, as the renamer does', () => {
    expect(render('TV/{tvshow}/Season {season_number}', { tvshow: 'Silo', season_number: 3 })).toBe(
      '/media/Staging/TV/Silo/Season 03',
    );
  });

  it('accepts {season} as an alias for the same value', () => {
    expect(render('TV/{tvshow}/Season {season}', { tvshow: 'Silo', season: 4 })).toBe(
      '/media/Staging/TV/Silo/Season 04',
    );
  });
});

describe('a token with no value', () => {
  /*
   * The alternative is a folder literally named "Rose of Nevada ()", which then
   * differs forever from the one the renamer would create.
   */
  it('drops the framing left empty rather than rendering "( )"', () => {
    expect(render('Movies/{movie} ({year})', { movie: 'Undated Film', year: null })).toBe(
      '/media/Staging/Movies/Undated Film',
    );
  });

  it('never renders the literal token or the word null', () => {
    const out = render('Movies/{movie} ({year})', { movie: 'X', year: undefined });
    expect(out).not.toMatch(/\{year\}|null|undefined/);
  });

  it('refuses when every token was empty and nothing is left', () => {
    expect(() => render('{movie} ({year})', { movie: null, year: null })).toThrow(
      /rendered to nothing/,
    );
  });
});

describe('provider titles are untrusted', () => {
  /*
   * A slash inside a title must not invent a directory level. `Face/Off` is one
   * folder, not two.
   */
  it('does not let a slash in a title create a directory', () => {
    expect(render('Movies/{movie}', { movie: 'Face/Off' })).toBe('/media/Staging/Movies/Face Off');
  });

  it('strips filesystem-illegal characters', () => {
    expect(render('Movies/{movie}', { movie: 'Who? What: Where*' })).toBe(
      '/media/Staging/Movies/Who What Where',
    );
  });

  it('strips control characters rather than writing them into a path', () => {
    const nasty = `Evil${String.fromCharCode(0)}Title${String.fromCharCode(27)}`;
    expect(render('Movies/{movie}', { movie: nasty })).toBe('/media/Staging/Movies/EvilTitle');
  });

  /*
   * Containment is what matters, but a leading-dot folder is a real problem of
   * its own: it is hidden from `ls` and from most file browsers, so an operator
   * hunting for the staging directory would not find it.
   */
  it('cannot climb out with .. in a title, and does not leave a hidden folder', () => {
    const out = render('Movies/{movie}', { movie: '../../etc/passwd' });
    expect(out).toBe('/media/Staging/Movies/etc passwd');
  });

  it('cannot climb out with .. in the template', () => {
    expect(render('../../{movie}', { movie: 'X' })).toBe('/media/Staging/X');
  });

  it('drops a title that is nothing but dots', () => {
    expect(() => render('{movie}', { movie: '...' })).toThrow(/rendered to nothing/);
  });

  it('collapses a title made only of illegal characters instead of creating a blank folder', () => {
    expect(() => render('{movie}', { movie: '???' })).toThrow(/rendered to nothing/);
  });

  it('does not let a title starting with a slash re-root the path', () => {
    expect(render('Movies/{movie}', { movie: '/etc/cron.d/evil' })).toBe(
      '/media/Staging/Movies/etc cron.d evil',
    );
  });

  it('handles a very long title without producing an empty segment', () => {
    const out = render('Movies/{movie}', { movie: 'A'.repeat(600) });
    expect(out.startsWith('/media/Staging/Movies/A')).toBe(true);
  });
});

describe('containment', () => {
  it('requires an absolute staging root', () => {
    expect(() =>
      renderTargetPath({ stagingRoot: 'relative/staging', pathTemplate: '{movie}', tokens: { movie: 'X' } }),
    ).toThrow(/absolute staging root/);
  });

  it('always lands inside the staging root', () => {
    for (const title of ['../x', '..', '/abs', 'a/../../b', 'normal']) {
      const out = render('Movies/{movie}', { movie: title });
      expect(out.startsWith('/media/Staging/')).toBe(true);
    }
  });

  /*
   * Managed intake places files INTO the library from wherever they landed. If
   * they already landed in that library the placement is library-to-library, and
   * the library gains a duplicate of everything it imports — the same conflict
   * `assertManagedSavePathIsStaging` refuses for hand-made rules.
   */
  it('refuses a staging path that would sit inside a destination library', () => {
    expect(() =>
      renderTargetPath({
        stagingRoot: '/media/Movies/incoming',
        pathTemplate: '{movie}',
        tokens: { movie: 'X' },
        libraryPaths: ['/media/Movies'],
      }),
    ).toThrow(/inside the library at \/media\/Movies/);
  });

  it('allows a staging root that merely shares a prefix with a library', () => {
    expect(
      renderTargetPath({
        stagingRoot: '/media/Movies-staging',
        pathTemplate: '{movie}',
        tokens: { movie: 'X' },
        libraryPaths: ['/media/Movies'],
      }),
    ).toBe('/media/Movies-staging/X');
  });

  it('tolerates a trailing slash on the root and on a library path', () => {
    expect(
      renderTargetPath({
        stagingRoot: '/media/Staging/',
        pathTemplate: '{movie}',
        tokens: { movie: 'X' },
        libraryPaths: ['/media/Movies/'],
      }),
    ).toBe('/media/Staging/X');
  });
});

describe('the template itself', () => {
  it('names an unknown token rather than rendering it literally', () => {
    expect(() => renderPathFragment('{library_path}/{movie}', { movie: 'X' })).toThrow(
      /\{library_path\}/,
    );
  });

  it('is idempotent — the same inputs give the same path', () => {
    const args = ['TV/{tvshow} ({year})', { tvshow: 'Silo', year: 2023 }] as const;
    expect(render(...args)).toBe(render(...args));
  });

  it('collapses repeated separators in the template', () => {
    expect(render('TV//{tvshow}///x', { tvshow: 'S' })).toBe('/media/Staging/TV/S/x');
  });
});
