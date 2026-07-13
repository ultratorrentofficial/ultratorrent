import { TvShowStatusService } from './tv-show-status.service';
import type { ShowSearchHit } from './tv-show-status-provider';

/**
 * Regression for "the provider always answers, so we always believed it".
 *
 * A provider's search is fuzzy: ask TMDB for a show it has never heard of and it still
 * returns something, ranked by its own relevance. `pickHit` used to fall back to
 * `hits[0]` whenever nothing matched exactly, so a miss did not produce "unknown" — it
 * produced *a different show*, cached under this title and written onto the rule as its
 * airing status. A non-exact hit must now resemble what we asked for, or we say nothing.
 */
describe('TvShowStatusService.pickHit similarity floor', () => {
  const svc = new TvShowStatusService({} as any, {} as any, {} as any, {} as any);
  const pick = (hits: ShowSearchHit[], title: string, year: number | null = null) =>
    (svc as any).pickHit(hits, title, year) as ShowSearchHit | null;

  const hit = (title: string, year: number | null = null): ShowSearchHit => ({
    providerShowId: title,
    title,
    year,
  });

  it('returns null rather than an unrelated show the provider merely ranked first', () => {
    // What TMDB would hand back for a show it does not carry.
    const hits = [hit('Rise', 2018), hit('Rise of the Pink Ladies', 2023)];
    expect(pick(hits, 'The Pendragon Cycle: Rise of the Merlin')).toBeNull();
  });

  it('still takes an exact title match', () => {
    const hits = [hit('Some Other Show'), hit('The Pendragon Cycle: Rise of the Merlin', 2026)];
    expect(pick(hits, 'The Pendragon Cycle: Rise of the Merlin')?.year).toBe(2026);
  });

  it('disambiguates same-titled shows by year', () => {
    const hits = [hit('Ghosts', 2019), hit('Ghosts', 2021)];
    expect(pick(hits, 'Ghosts', 2021)?.year).toBe(2021);
  });

  it('accepts a close-but-not-exact title (a catalogue rename)', () => {
    expect(pick([hit('The Office (US)', 2005)], 'The Office')).not.toBeNull();
  });

  it('prefers the closest title when several clear the floor', () => {
    const hits = [hit('The Bear Necessities'), hit('The Bear', 2022)];
    expect(pick(hits, 'The Bear')?.year).toBe(2022);
  });

  it('returns null on no hits at all', () => {
    expect(pick([], 'Anything')).toBeNull();
  });
});
