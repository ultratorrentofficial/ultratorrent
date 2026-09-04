import { TmdbMetadataProvider } from './metadata-provider';

/**
 * Breaking a title+year tie with evidence about the FILE.
 *
 * Title and year are what tied, so only a third axis can separate the
 * candidates. Every case here is measured from the live library on 2026-09-04,
 * where six of nineteen films in the Movies newsletter went out with no artwork
 * because the matcher could see a tie and had nothing to resolve it with.
 */

/** Builds a provider whose HTTP layer is a fixture map, and records every call. */
function provider(search: any[], details: Record<string, any>) {
  const p = new TmdbMetadataProvider('test-key');
  const calls: string[] = [];
  (p as unknown as { get: (path: string, params: Record<string, string>) => Promise<any> }).get =
    async (path, params) => {
      calls.push(path);
      if (path.startsWith('/search/movie')) return { results: params.year ? search : search };
      if (path.startsWith('/find/')) return { movie_results: [details[path.split('/')[2]]].filter(Boolean) };
      const id = path.split('/')[2];
      return details[id] ?? null;
    };
  return { p, calls };
}

const cand = (id: number, title: string, date: string | null) => ({
  id, title, original_title: title, release_date: date,
});
const detail = (id: number, title: string, runtime: number | null, alts: string[] = []) => ({
  id, title, original_title: title, runtime,
  alternative_titles: { titles: alts.map((t) => ({ title: t })) },
});

describe('rung 2 — the file’s measured runtime', () => {
  // TMDB carries three separate 2026 films titled exactly "The Odyssey".
  const odyssey = [cand(1368337, 'The Odyssey', '2026-07-15'), cand(1698863, 'The Odyssey', '2026-07-03'), cand(1756234, 'The Odyssey', '2026-07-14')];
  const odysseyDetails = {
    '1368337': detail(1368337, 'The Odyssey', 173),
    '1698863': detail(1698863, 'The Odyssey', 86),
    '1756234': detail(1756234, 'The Odyssey', 92),
  };

  it('picks the film whose runtime matches the container (86m, not 92m or 173m)', async () => {
    const { p } = provider(odyssey, odysseyDetails);
    const d = await p.fetchDetails({ kind: 'movie', title: 'The Odyssey', year: 2026, durationSec: 5163 });
    expect(d?.externalIds?.tmdb).toBe('1698863');
  });

  it('still refuses when no duration was measured — a tie with no evidence is a tie', async () => {
    const { p } = provider(odyssey, odysseyDetails);
    expect(await p.fetchDetails({ kind: 'movie', title: 'The Odyssey', year: 2026 })).toBeNull();
  });

  /*
   * The extended-cut case. TMDB gives one entry per film and lists the
   * theatrical runtime, so a long cut matches nothing — and must REFUSE rather
   * than settle on whichever candidate happens to be nearest.
   */
  it('refuses an extended cut rather than picking the closest candidate', async () => {
    const { p } = provider(odyssey, odysseyDetails);
    // 210 minutes: longer than every candidate, nearest is 173m.
    const d = await p.fetchDetails({ kind: 'movie', title: 'The Odyssey', year: 2026, durationSec: 12600 });
    expect(d).toBeNull();
  });

  it('refuses when two candidates both sit inside the tolerance', async () => {
    const { p } = provider(
      [cand(1, 'Twin', '2026-01-01'), cand(2, 'Twin', '2026-01-01')],
      { '1': detail(1, 'Twin', 100), '2': detail(2, 'Twin', 100) },
    );
    expect(await p.fetchDetails({ kind: 'movie', title: 'Twin', year: 2026, durationSec: 6000 })).toBeNull();
  });

  it('holds the tolerance tight — a 6-minute gap is a different film', async () => {
    const { p } = provider(
      [cand(1, 'Solo', '2026-01-01'), cand(2, 'Solo', '2026-01-01')],
      { '1': detail(1, 'Solo', 86), '2': detail(2, 'Solo', 92) },
    );
    // 92m file: only the 92m candidate is inside +/-2m.
    const d = await p.fetchDetails({ kind: 'movie', title: 'Solo', year: 2026, durationSec: 5520 });
    expect(d?.externalIds?.tmdb).toBe('2');
  });
});

describe('rung 3 — the name the file arrived as', () => {
  it('breaks a tie on a title carried in the release path', async () => {
    const { p } = provider(
      [cand(1, 'Nomad', '2026-01-01'), cand(2, 'Nomad', '2026-01-01')],
      {
        '1': detail(1, 'Nomad', null, ['Nomad: Blood Harvest']),
        '2': detail(2, 'Nomad', null, ['Nomad: Silent Road']),
      },
    );
    const d = await p.fetchDetails({
      kind: 'movie', title: 'Nomad', year: 2026,
      releaseName: '/downloads/complete/Nomad.Silent.Road.2026.1080p.WEB-DL/nomad.mkv',
    });
    expect(d?.externalIds?.tmdb).toBe('2');
  });

  it('refuses when the release name hits both candidates', async () => {
    const { p } = provider(
      [cand(1, 'Nomad', '2026-01-01'), cand(2, 'Nomad', '2026-01-01')],
      { '1': detail(1, 'Nomad', null), '2': detail(2, 'Nomad', null) },
    );
    const d = await p.fetchDetails({
      kind: 'movie', title: 'Nomad', year: 2026, releaseName: '/downloads/Nomad.2026.1080p/nomad.mkv',
    });
    expect(d).toBeNull();
  });
});

describe('the retitle rescue', () => {
  /*
   * `Three Bags Full A Sheep Detective Movie` scored 0.35 against the only title
   * the search returned — "The Sheep Detectives" — and was rejected. TMDB carries
   * the folder's exact name as a registered alternative title on that same film.
   */
  it('matches a film published under a different name (Three Bags Full)', async () => {
    const { p } = provider(
      [cand(1301421, 'The Sheep Detectives', '2026-04-30')],
      { '1301421': detail(1301421, 'The Sheep Detectives', 109, ['Three Bags Full: A Sheep Detective Movie', 'Bêêêêtective Privé']) },
    );
    const d = await p.fetchDetails({
      kind: 'movie', title: 'Three Bags Full A Sheep Detective Movie', year: 2026,
    });
    expect(d?.externalIds?.tmdb).toBe('1301421');
  });

  it('matches Middletown → Teenage Wasteland', async () => {
    const { p } = provider(
      [cand(1400383, 'Teenage Wasteland', '2025-11-26')],
      { '1400383': detail(1400383, 'Teenage Wasteland', 110, ['Middletown']) },
    );
    const d = await p.fetchDetails({ kind: 'movie', title: 'Middletown', year: 2025 });
    expect(d?.externalIds?.tmdb).toBe('1400383');
  });

  it('requires an EXACT alternative title, not a near one', async () => {
    const { p } = provider(
      [cand(9, 'Something Else', '2026-01-01')],
      { '9': detail(9, 'Something Else', 100, ['Middletown Blues']) },
    );
    expect(await p.fetchDetails({ kind: 'movie', title: 'Middletown', year: 2026 })).toBeNull();
  });

  it('keeps the year gate — an exact alt title in the wrong decade is a different film', async () => {
    const { p } = provider(
      [cand(9, 'Teenage Wasteland', '1998-01-01')],
      { '9': detail(9, 'Teenage Wasteland', 110, ['Middletown']) },
    );
    expect(await p.fetchDetails({ kind: 'movie', title: 'Middletown', year: 2025 })).toBeNull();
  });

  it('never overrides a clean win — the rescue only runs when nothing matched', async () => {
    const { p, calls } = provider(
      [cand(5, 'Rose of Nevada', '2026-01-01')],
      { '5': detail(5, 'Rose of Nevada', 114) },
    );
    const d = await p.fetchDetails({ kind: 'movie', title: 'Rose of Nevada', year: 2026 });
    expect(d?.externalIds?.tmdb).toBe('5');
    // One detail call for the winner, none for a cascade that never ran.
    expect(calls.filter((c) => c.includes('alternative_titles')).length).toBe(0);
  });
});

describe('rung 1 — an id we already hold', () => {
  it('resolves by a sidecar NFO’s tmdb id without searching at all', async () => {
    const { p, calls } = provider([], { '1698863': detail(1698863, 'The Odyssey', 86) });
    const d = await p.fetchDetails({
      kind: 'movie', title: 'The Odyssey', year: 2026, knownIds: { tmdb: '1698863' },
    });
    expect(d?.externalIds?.tmdb).toBe('1698863');
    expect(calls.some((c) => c.startsWith('/search/movie'))).toBe(false);
  });

  it('resolves an imdb id through /find, again without a title search', async () => {
    const { p, calls } = provider([], { 'tt1234567': detail(1698863, 'The Odyssey', 86) });
    const d = await p.fetchDetails({
      kind: 'movie', title: 'Whatever The Folder Says', year: 2026, knownIds: { imdb: 'tt1234567' },
    });
    expect(d?.externalIds?.tmdb).toBe('1698863');
    expect(calls.some((c) => c.startsWith('/search/movie'))).toBe(false);
  });
});
