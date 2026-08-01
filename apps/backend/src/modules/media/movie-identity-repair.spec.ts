/**
 * Repairing identities the unverified TMDB lookup got wrong.
 *
 * On the live library one imdb id — `tt1790864` — is held by three different
 * films: `The Maze Runner (2014)`, `Maze (2017)` and `The Runner (2015)`. The
 * Duplicate Center groups on external id, so it presented them as one film in
 * triplicate with 3.05 GB "reclaimable". Acting on that deletes two other movies.
 *
 * The folder is the trustworthy signal — `rename_in_place` never rewrites it —
 * while the filename and stored title were both overwritten with the wrong
 * film's. So identity is re-derived from the folder and re-verified, and an
 * unverifiable id is dropped rather than kept.
 */
import { MovieIdentityRepairService } from './movie-identity-repair.service';

/**
 * Three folders, one contaminated identity — the live case, minus the network.
 *
 * BOTH providers are present on every item, exactly as on the real library
 * (`tt1790864` / `198663` on all three). A fixture carrying only `imdb` would
 * make the already-correct item look like it needed a change, purely because the
 * repair would be "adding" the tmdb id the real row already has.
 */
const PAIR = (itemId: string, folder: string) => [
  { provider: 'imdb', externalId: 'tt1790864', itemId, item: { path: `/m/Movies/HD Movies/${folder}/The Maze Runner (2014) - 1080p.mp4` } },
  { provider: 'tmdb', externalId: '198663', itemId, item: { path: `/m/Movies/HD Movies/${folder}/The Maze Runner (2014) - 1080p.mp4` } },
];
const MAZE = [
  ...PAIR('a', 'The Maze Runner (2014)'),
  ...PAIR('b', 'Maze (2017)'),
  ...PAIR('c', 'The Runner (2015)'),
];

/** A film whose id is held by only its own folder — must be left alone. */
const CLEAN = [
  { provider: 'imdb', externalId: 'tt0468569', itemId: 'z', item: { path: '/m/Movies/HD Movies/The Dark Knight (2008)/The Dark Knight (2008) - 1080p.mp4' } },
];

function build(
  rows: typeof MAZE,
  resolver: (title: string, year: number | null) => Record<string, string>,
  /** title -> the tmdb ids that tied, for the ambiguous cases. */
  ties: (title: string) => string[] = () => [],
) {
  const deleted: string[] = [];
  const created: Array<{ itemId: string; provider: string; externalId: string }> = [];
  const prisma = {
    mediaExternalId: {
      findMany: jest.fn(async () => rows),
      deleteMany: jest.fn(async ({ where }: any) => { deleted.push(where.itemId); return { count: 1 }; }),
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
    },
  };
  const fetchDetails = jest.fn(async (q: { title: string; year: number | null }) => {
    const ids = resolver(q.title, q.year);
    return Object.keys(ids).length ? { externalIds: ids } : null;
  });
  const ambiguousMovieIds = jest.fn(async (q: { title: string }) => ties(q.title));
  const providers = { chain: jest.fn(async () => [{ name: 'tmdb', fetchDetails, ambiguousMovieIds }]) };
  const svc = new MovieIdentityRepairService(prisma as never, providers as never);
  return { svc, deleted, created, fetchDetails, ambiguousMovieIds };
}

/** Correct answers for the three real films. */
const truth = (title: string): Record<string, string> =>
  ({
    'The Maze Runner': { imdb: 'tt1790864', tmdb: '198663' },
    Maze: { imdb: 'tt5182124', tmdb: '5182124' },
    'The Runner': { imdb: 'tt3626476', tmdb: '3626476' },
  })[title] ?? {};

describe('detecting contamination', () => {
  it('flags an id claimed by more than one movie folder', async () => {
    const { svc } = build(MAZE, truth);
    const bad = await svc.contaminated();
    expect(bad.map((b) => b.itemId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves an id held by a single folder alone', async () => {
    const { svc } = build(CLEAN as never, truth);
    expect(await svc.contaminated()).toHaveLength(0);
  });

  it("reports an implicated item's COMPLETE identity, not just the colliding id", async () => {
    // `apply` replaces an item's ids wholesale, so an id omitted here is an id
    // deleted. Item 'b' collides on imdb only; its tmdb id must survive the trip.
    const rows = MAZE.map((r) =>
      r.itemId === 'b' && r.provider === 'tmdb' ? { ...r, externalId: 'private-to-b' } : r,
    );
    const { svc } = build(rows, truth);
    const b = (await svc.contaminated()).find((i) => i.itemId === 'b')!;
    expect(b.ids).toEqual({ imdb: 'tt1790864', tmdb: 'private-to-b' });
    // …but only the genuinely colliding id is counted as contamination.
    expect(b.guilty).toEqual(['imdb']);
  });

  it('counts the colliding ids only', async () => {
    const rows = MAZE.map((r) =>
      r.itemId === 'b' && r.provider === 'tmdb' ? { ...r, externalId: 'private-to-b' } : r,
    );
    const { svc } = build(rows, truth);
    // imdb tt1790864 (3 folders) and tmdb 198663 (2 folders) — 'private-to-b' is
    // held by one folder and must not inflate the total.
    expect((await svc.preview()).contaminatedIds).toBe(2);
  });

  it('reads identity from the FOLDER, never the filename', async () => {
    // Every one of these files is NAMED "The Maze Runner (2014)". Trusting the
    // filename would confirm the corruption instead of repairing it.
    const { svc } = build(MAZE, truth);
    const { proposals } = await svc.preview();
    expect(proposals.map((p) => p.folderTitle).sort()).toEqual(['Maze', 'The Maze Runner', 'The Runner']);
  });

  it('parses a canonical movie folder', () => {
    const { svc } = build(MAZE, truth);
    expect(svc.parseFolder('Maze (2017)')).toEqual({ title: 'Maze', year: 2017 });
    expect(svc.parseFolder('Face Off')).toEqual({ title: 'Face Off', year: null });
  });
});

/**
 * A folder is only trustworthy if it is read correctly.
 *
 * The parse used to demand `Title (YYYY)` at the very END, so a scene folder gave
 * up the whole string as a title and no year at all. That is worse than useless
 * here: an unparseable title verifies against nothing, and this service's answer to
 * "nothing verified" is to CLEAR the id — so a perfectly good film would have lost
 * its identity because of its folder's suffix.
 */
describe('reading a movie folder', () => {
  const parse = (name: string) => build(MAZE, truth).svc.parseFolder(name);

  it('ignores the release junk trailing a canonical name', () => {
    expect(parse('Midas Man (2024) [BLURAY] [1080p] [BluRay] [5.1] [YTS.MX]')).toEqual({
      title: 'Midas Man',
      year: 2024,
    });
  });

  it('ignores a Plex/Emby id or edition tag', () => {
    expect(parse('Aladdin (1992) {tmdb-812}')).toEqual({ title: 'Aladdin', year: 1992 });
    expect(parse("Blade Runner (1982) {edition-Director's Cut}")).toEqual({
      title: 'Blade Runner',
      year: 1982,
    });
  });

  it('keeps a parenthesised edition that is part of the title', () => {
    // Only a 4-digit group is a year; the qualifier stays with the title it qualifies.
    expect(parse("Alien (Director's Cut) (1979)")).toEqual({
      title: "Alien (Director's Cut)",
      year: 1979,
    });
  });

  it('reads a bare release year and stops the title there', () => {
    expect(parse('Midas Man 2024 1080p BluRay x264-GROUP')).toEqual({ title: 'Midas Man', year: 2024 });
    expect(parse('Midas.Man.2024.1080p.WEB-DL.DDP5.1')).toEqual({ title: 'Midas Man', year: 2024 });
  });

  it('stops at the release tags even when there is no year to find', () => {
    expect(parse('Midas Man 1080p BluRay')).toEqual({ title: 'Midas Man', year: null });
  });

  it('does not mistake a number IN the title for a year', () => {
    // The two ways this goes wrong, and both are silent: a year-shaped token that
    // is really the title, and a real year that also opens it.
    expect(parse('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049', year: null });
    expect(parse('2012 (2009)')).toEqual({ title: '2012', year: 2009 });
    expect(parse('1917')).toEqual({ title: '1917', year: null });
  });

  it('never returns an empty title', () => {
    // An empty title searches for everything, and the first popular answer wins —
    // which is precisely how the ids got contaminated in the first place.
    expect(parse('(2019)').title).not.toBe('');
    expect(parse('[1080p]').title).not.toBe('');
  });
});

describe('proposing the repair', () => {
  it('re-identifies each folder to its own film', async () => {
    const { svc } = build(MAZE, truth);
    const { proposals } = await svc.preview();
    const byFolder = Object.fromEntries(proposals.map((p) => [p.folderTitle, p]));
    expect(byFolder['Maze'].proposed.imdb).toBe('tt5182124');
    expect(byFolder['The Runner'].proposed.imdb).toBe('tt3626476');
    // The one that was right all along is reported as needing nothing.
    expect(byFolder['The Maze Runner'].action).toBe('unchanged');
  });

  it('CLEARS an id it cannot verify rather than keeping a wrong one', async () => {
    // The stated principle, enforced: no id is correct-but-incomplete; a wrong id
    // corrupts detection, dedup and every downstream lookup.
    const { svc } = build(MAZE, (t) => (t === 'Maze' ? {} : truth(t)));
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.action).toBe('clear');
    expect(maze.proposed).toEqual({});
    expect(maze.reason).toMatch(/worse than none/);
  });

  it('asks the provider once per folder, not once per item', async () => {
    // Several items can share a folder, and the API is rate-limited.
    const dupes = [...MAZE, { ...MAZE[1], itemId: 'b2' }];
    const { svc, fetchDetails } = build(dupes, truth);
    await svc.preview();
    expect(fetchDetails).toHaveBeenCalledTimes(3); // three folders, four items
  });

  it('writes nothing during a preview', async () => {
    const { svc, deleted, created } = build(MAZE, truth);
    await svc.preview();
    expect(deleted).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

/**
 * A tie is several answers, not none.
 *
 * "Cannot verify" hides two situations that deserve opposite treatment. A blank
 * says the stored id is unsupported. A tie — TMDB genuinely holds three different
 * `Aladdin (1992)` and five different `Run (2020)` — says the query is not
 * specific enough to choose, which is no evidence against the id already there.
 * Measured live, every stored id that appeared in its own tied set was the right
 * film and every one that did not was the contaminant.
 */
describe('an ambiguous folder', () => {
  /** "Maze" ties between three films; 'b' currently holds the first of them. */
  const TIED = ['tt5182124', 'tt9999991', 'tt9999992'];
  const tmdbTied = ['5182124', '9999991', '9999992'];
  const nothingVerifies = (t: string) => (t === 'Maze' ? {} : truth(t));

  it('KEEPS the stored id when it is one of the tied films', async () => {
    // 'b' holds tmdb 198663 — not in the tied set — so start it on a tied id.
    const rows = MAZE.map((r) =>
      r.itemId === 'b' && r.provider === 'tmdb' ? { ...r, externalId: '5182124' } : r,
    );
    const { svc } = build(rows, nothingVerifies, (t) => (t === 'Maze' ? tmdbTied : []));
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.action).toBe('unchanged');
    expect(maze.proposed).toEqual(maze.current);
    expect(maze.ambiguous).toBe(true);
    expect(maze.reason).toMatch(/stored id is one of them/);
  });

  it('CLEARS when the stored id is not among the tied films', async () => {
    // The live shape: "The Dark (2018)" ties between two real films and holds
    // The Dark Knight's id, which is neither of them.
    const { svc } = build(MAZE, nothingVerifies, (t) => (t === 'Maze' ? tmdbTied : []));
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.action).toBe('clear');
    expect(maze.proposed).toEqual({});
    expect(maze.ambiguous).toBe(true);
    expect(maze.reason).toMatch(/none is the stored id/);
  });

  it('still clears on a genuine blank, which is not a tie', async () => {
    const { svc } = build(MAZE, nothingVerifies);
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.action).toBe('clear');
    expect(maze.ambiguous).toBe(false);
    expect(maze.reason).toMatch(/worse than none/);
  });

  it('does not ask about ambiguity when the folder resolved cleanly', async () => {
    // The second question costs a second search, so it must stay on the rare path.
    const { svc, ambiguousMovieIds } = build(MAZE, truth);
    await svc.preview();
    expect(ambiguousMovieIds).not.toHaveBeenCalled();
  });

  it("weighs each item's OWN id, not the first one under the folder", async () => {
    // Two items share the "Maze" folder. Both are implicated by the shared imdb
    // id, but their tmdb ids differ: b2's is one of the tied films, b's is not.
    // Memoising the verdict rather than the provider answer would apply the first
    // item's outcome to both.
    const rows = [
      ...MAZE,
      { provider: 'imdb', externalId: 'tt1790864', itemId: 'b2', item: { path: MAZE[2].item.path } },
      { provider: 'tmdb', externalId: '5182124', itemId: 'b2', item: { path: MAZE[2].item.path } },
    ];
    const { svc } = build(rows as never, nothingVerifies, (t) => (t === 'Maze' ? tmdbTied : []));
    const { proposals } = await svc.preview();
    const byItem = Object.fromEntries(proposals.map((p) => [p.itemId, p]));
    expect(byItem['b'].action).toBe('clear');       // holds 198663 — not tied
    expect(byItem['b2'].action).toBe('unchanged');  // holds 5182124 — tied
  });

  it('leaves a lone candidate alone — one is not a tie', async () => {
    const { svc } = build(MAZE, nothingVerifies, (t) => (t === 'Maze' ? ['5182124'] : []));
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.ambiguous).toBe(false);
    expect(maze.action).toBe('clear');
  });

  it('survives a provider that cannot report ambiguity at all', async () => {
    // The optional method is absent — degrade to clearing, never to guessing.
    const prisma = {
      mediaExternalId: {
        findMany: jest.fn(async () => MAZE),
        deleteMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(async ({ data }: any) => data),
      },
    };
    const providers = {
      chain: jest.fn(async () => [{ name: 'legacy', fetchDetails: jest.fn(async () => null) }]),
    };
    const svc = new MovieIdentityRepairService(prisma as never, providers as never);
    const { proposals } = await svc.preview();
    expect(proposals.every((p) => p.action === 'clear')).toBe(true);
  });

  it('does not resurrect a TIE as a keep when the ids disagree on provider', async () => {
    // The tied set is TMDB's id space. An item carrying only an imdb id has
    // nothing comparable in it, so it must not be kept on a coincidence.
    const rows = MAZE.filter((r) => !(r.itemId === 'b' && r.provider === 'tmdb'));
    const { svc } = build(rows, nothingVerifies, (t) => (t === 'Maze' ? TIED : []));
    const { proposals } = await svc.preview();
    const maze = proposals.find((p) => p.folderTitle === 'Maze')!;
    expect(maze.action).toBe('clear');
  });
});

describe('applying the repair', () => {
  it('replaces the wrong ids with the verified ones', async () => {
    const { svc, created } = build(MAZE, truth);
    const r = await svc.apply();
    expect(r).toMatchObject({ reidentified: 2, cleared: 0, unchanged: 1 });
    expect(created).toContainEqual({ itemId: 'b', provider: 'imdb', externalId: 'tt5182124' });
    expect(created).toContainEqual({ itemId: 'c', provider: 'imdb', externalId: 'tt3626476' });
  });

  it('deletes the wrong rows even when nothing replaces them', async () => {
    // A clear must actually remove the id. Leaving it would keep the false
    // duplicate group alive, which is the entire symptom being repaired.
    const { svc, deleted, created } = build(MAZE, (t) => (t === 'Maze' ? {} : truth(t)));
    const r = await svc.apply();
    expect(r.cleared).toBe(1);
    expect(deleted).toContain('b');
    expect(created.filter((c) => c.itemId === 'b')).toHaveLength(0);
  });

  it('does not touch an item that was already correct', async () => {
    const { svc, deleted } = build(MAZE, truth);
    await svc.apply();
    expect(deleted).not.toContain('a');
  });

  it('re-previews instead of trusting a plan handed to it', async () => {
    // The library can change between preview and apply; an id written from a
    // stale plan is exactly the error this service exists to undo.
    const { svc, fetchDetails } = build(MAZE, truth);
    await svc.preview();
    const after = fetchDetails.mock.calls.length;
    await svc.apply();
    expect(fetchDetails.mock.calls.length).toBeGreaterThan(after);
  });
});
