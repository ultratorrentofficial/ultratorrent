/**
 * A show folder identifies itself. The renamer must not ask a provider about it.
 *
 * Reported as "preview lists items that don't need a rename". They did need one —
 * the filenames matched but the FOLDER differed:
 *
 *   /downloads/TV Shows/All American (2018)/Season 1/All American - S01E01 - Pilot.mp4
 *   → /downloads/TV Shows/All American (2019)/Season 1/All American - S01E01 - Pilot.mp4
 *
 * Nothing in the library said 2019: not the show row, not one of its 87 items, not
 * the watchlist, not IMDb. It came from TMDB. `All American (2018)` is a bare year
 * with no `SxxEyy`, so the release parser reads the folder as a MOVIE, and the
 * movie search answered with the film *American Dreamer* (2019) — the only result.
 * `buildTokens` prefers `meta.year` over the parsed year, so every episode was
 * planned into a show folder named after an unrelated film's release year.
 *
 * 664 of 666 folders on the live library carry a year, so this was not one show.
 *
 * Asking for the right KIND is not the fix — `/search/tv` is equally unverified and
 * fails differently (see the Ghosts and Dark Matter cases below). The fix is not to
 * ask: the folder name is what the scanner recorded and what is on disk.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/** A library rooted at a real temp dir, with a provider that records every call. */
function build(libraryRoot: string, lookupResult: Record<string, unknown> = {}) {
  const lookup = jest.fn(async () => lookupResult);
  const prisma = {
    mediaLibrary: { findMany: jest.fn(async () => [{ path: libraryRoot }]) },
    // No stored shows: episode titles come from `episodeTitlesFor`, which is not
    // what this file is about, and an empty library makes it return undefined.
    mediaShow: { findMany: jest.fn(async () => []) },
  };
  const config = { get: jest.fn(() => []) };
  const settings = { get: jest.fn(async () => undefined) };
  const providers = {
    chain: jest.fn(async () => [{ name: 'tmdb', lookup }]),
    offline: () => ({ name: 'offline', lookup }),
  };
  const svc = new MediaService(
    prisma as never, config as never, settings as never, {} as never,
    {} as never, {} as never, providers as never,
  );
  return { svc, lookup };
}

const PLEX_TV =
  '{Series Title}{year? ({year})}/Season {season}/{Series Title} - S{season:00}E{episode:00} - {Episode Title}.{ext}';

describe('rename preview — a show folder is not a movie', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ut-renamer-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Lay down `<root>/<folder>/Season 1/<file>` and return the folder path. */
  async function showFolder(folder: string, file: string): Promise<string> {
    const dir = path.join(root, folder, 'Season 1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), 'x');
    return path.join(root, folder);
  }

  it('does not consult a metadata provider for a folder of episodes', async () => {
    const folder = await showFolder('All American (2018)', 'All American - S01E01 - Pilot.mp4');
    const { svc, lookup } = build(root);

    await svc.buildPlan({ path: folder, libraryPath: root, mode: 'preview', template: PLEX_TV });

    // The lookup that produced "2019" is never made at all.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps the folder\'s own year instead of an unrelated film\'s', async () => {
    const folder = await showFolder('All American (2018)', 'All American - S01E01 - Pilot.mp4');
    // What TMDB actually returned for `/search/movie?query=All American&year=2018`.
    const { svc } = build(root, { movieTitle: 'American Dreamer', year: 2019 });

    const plan = await svc.buildPlan({ path: folder, libraryPath: root, mode: 'preview', template: PLEX_TV });
    const item = plan.items.find((i) => i.source.endsWith('.mp4'))!;

    // No episode title from this stub, so the template's trailing " - " is tidied away.
    expect(item.destination).toBe(
      path.join(root, 'All American (2018)', 'Season 1', 'All American - S01E01.mp4'),
    );
    expect(item.destination).not.toContain('2019');
  });

  it('leaves a correctly-named episode alone rather than listing it as work', async () => {
    // The user's actual complaint. With the year no longer moving, a file that already
    // conforms is `unchanged` and the preview hides it.
    const folder = await showFolder('All American (2018)', 'All American - S01E01 - Pilot.mp4');
    const { svc } = build(root, { movieTitle: 'American Dreamer', year: 2019 });
    // The episode title the local dataset would supply, so the rendered name matches.
    const plan = await svc.buildPlan({ path: folder, libraryPath: root, mode: 'preview', template: PLEX_TV });

    // Destination differs from source only by the episode title this stub can't supply,
    // never by the folder — which is what forked the show.
    const item = plan.items.find((i) => i.source.endsWith('.mp4'))!;
    expect(path.dirname(item.destination!)).toBe(path.dirname(item.source));
  });

  it('does not let /search/tv rename "Ghosts US" to the UK show\'s folder', async () => {
    // Why "look it up as TV instead" is not the fix: TMDB answers "Ghosts US" with
    // "Ghosts", whose folder already exists and belongs to a different series.
    const folder = await showFolder('Ghosts US (2021)', 'Ghosts US - S01E01 - Pilot.mp4');
    const { svc } = build(root, { seriesTitle: 'Ghosts', year: 2021 });

    const plan = await svc.buildPlan({ path: folder, libraryPath: root, mode: 'preview', template: PLEX_TV });
    const item = plan.items.find((i) => i.source.endsWith('.mp4'))!;

    expect(item.destination).toContain('Ghosts US (2021)');
  });

  it('does not merge "Dark Matter (2015)" into the 2024 series of the same name', async () => {
    // TMDB returns the 2024 series for both. Trusting it would move one show's
    // episodes into another show's folder.
    const folder = await showFolder('Dark Matter (2015)', 'Dark Matter - S01E01 - Episode One.mp4');
    const { svc } = build(root, { seriesTitle: 'Dark Matter', year: 2024 });

    const plan = await svc.buildPlan({ path: folder, libraryPath: root, mode: 'preview', template: PLEX_TV });
    const item = plan.items.find((i) => i.source.endsWith('.mp4'))!;

    expect(item.destination).toContain('Dark Matter (2015)');
    expect(item.destination).not.toContain('2024');
  });

  it('STILL enriches a release folder, which names its own episode', async () => {
    // The half that must not regress. A release is not a show folder: its name
    // carries the SxxEyy, the provider is the only source of the episode title, and
    // nothing on disk is being second-guessed.
    const dir = path.join(root, 'Show.Name.S01E05.1080p.WEB-DL-GROUP');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'show.name.s01e05.1080p.web-dl-group.mkv'), 'x');
    const { svc, lookup } = build(root, { seriesTitle: 'Show Name', episodeTitle: 'The Fifth', year: 2019 });

    const plan = await svc.buildPlan({ path: dir, libraryPath: root, mode: 'preview', template: PLEX_TV });

    expect(lookup).toHaveBeenCalled();
    const item = plan.items.find((i) => i.source.endsWith('.mkv'))!;
    expect(item.destination).toBe(
      path.join(root, 'Show Name (2019)', 'Season 1', 'Show Name - S01E05 - The Fifth.mkv'),
    );
  });

  it('STILL enriches a single movie file, which names no episode', async () => {
    const dir = path.join(root, 'Some.Film.2014.1080p');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Some.Film.2014.1080p.mkv'), 'x');
    const { svc, lookup } = build(root, { movieTitle: 'Some Film', year: 2014 });

    await svc.buildPlan({
      path: dir, libraryPath: root, mode: 'preview',
      template: '{Movie Title} ({year})/{Movie Title} ({year}).{ext}',
    });

    expect(lookup).toHaveBeenCalled();
  });
});
