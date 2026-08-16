import { mkdtemp, writeFile, rm, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { IntakeStagesService } from './intake-stages.service';

/**
 * What happens when the destination name is already taken.
 *
 * Skipping was the old answer and it silently dropped the new release: the
 * library kept the old copy, the new one stayed in staging seeding forever, and
 * the job still reported `imported`. Nothing could see it either — staging is in
 * no library, so duplicate detection never looks there. Moving the old copy
 * aside puts BOTH in the library, where the duplicate engine and Plex can show
 * them.
 */
// setAside touches only the filesystem, so every collaborator is inert here.
const svc = () => new IntakeStagesService(
  {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
);
const setAside = (s: IntakeStagesService, dest: string) =>
  (s as never as { setAside(d: string): Promise<string> }).setAside(dest);

describe('IntakeStagesService.setAside', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'setaside-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('frees the canonical name using [dupN], not (N)', async () => {
    /*
     * `(N)` is already how episode TITLES carry a part number — a live library
     * holds 481 of them, "The Box (1)" and "The Box (2)" being two DIFFERENT
     * episodes. Reusing it would make a redundant copy indistinguishable from a
     * two-parter.
     */
    await writeFile(path.join(dir, 'Backrooms (2026).mp4'), 'old');
    const to = await setAside(svc(), path.join(dir, 'Backrooms (2026).mp4'));

    expect(path.basename(to)).toBe('Backrooms (2026) [dup2].mp4');
    expect(await readdir(dir)).not.toContain('Backrooms (2026).mp4');
  });

  it('takes the sidecars with it', async () => {
    // The renamer names subtitles after the video, so leaving them behind would
    // silently re-attach the OLD copy's subtitles to the NEW file.
    for (const n of ['Movie (2026).mp4', 'Movie (2026).srt', 'Movie (2026).ara.srt', 'Movie (2026)-thumb.jpg']) {
      await writeFile(path.join(dir, n), 'x');
    }
    await setAside(svc(), path.join(dir, 'Movie (2026).mp4'));
    const after = await readdir(dir);

    expect(after.sort()).toEqual([
      'Movie (2026) [dup2)-thumb.jpg'.replace(')-', ']-'),
      'Movie (2026) [dup2].ara.srt',
      'Movie (2026) [dup2].mp4',
      'Movie (2026) [dup2].srt',
    ].sort());
  });

  it('leaves an unrelated file with a similar name alone', async () => {
    // "Movie (2026) 2.mp4" is a different title, not a sidecar of this one.
    await writeFile(path.join(dir, 'Movie (2026).mp4'), 'x');
    await writeFile(path.join(dir, 'Movie (2026) 2.mp4'), 'other');
    await setAside(svc(), path.join(dir, 'Movie (2026).mp4'));

    expect(await readdir(dir)).toContain('Movie (2026) 2.mp4');
  });

  it('picks the next free N rather than clobbering an earlier one', async () => {
    await writeFile(path.join(dir, 'Movie (2026).mp4'), 'new');
    await writeFile(path.join(dir, 'Movie (2026) [dup2].mp4'), 'older');
    const to = await setAside(svc(), path.join(dir, 'Movie (2026).mp4'));

    expect(path.basename(to)).toBe('Movie (2026) [dup3].mp4');
    // The earlier copy is untouched.
    expect(await readdir(dir)).toContain('Movie (2026) [dup2].mp4');
  });

  it('keeps one family on ONE suffix', async () => {
    // The video and its subtitle must not drift onto different numbers, or the
    // subtitle stops matching the copy it belongs to.
    await writeFile(path.join(dir, 'Movie (2026).mp4'), 'x');
    await writeFile(path.join(dir, 'Movie (2026).srt'), 'x');
    await writeFile(path.join(dir, 'Movie (2026) [dup2].srt'), 'taken');
    await setAside(svc(), path.join(dir, 'Movie (2026).mp4'));
    const after = await readdir(dir);

    expect(after).toContain('Movie (2026) [dup3].mp4');
    expect(after).toContain('Movie (2026) [dup3].srt');
  });

  it('does not disturb a hardlink to the same bytes elsewhere', async () => {
    // Renaming a name never touches the inode, so a seeding torrent keeps its
    // own path and keeps seeding.
    const lib = path.join(dir, 'Movie (2026).mp4');
    const seeding = path.join(dir, 'seeding.mp4');
    await writeFile(lib, 'x'.repeat(50));
    await link(lib, seeding);
    await setAside(svc(), lib);

    expect(await readdir(dir)).toContain('seeding.mp4');
  });
});

/**
 * A colliding SIDECAR must not drag the film with it.
 *
 * The family sweep exists so that moving a video aside takes its subtitles
 * along — otherwise the old copy's subtitles silently re-attach to the new
 * file. But it keyed on the stem, and the stem of `Movie - 1080p.srt` is
 * `Movie - 1080p`, which `Movie - 1080p.mp4` also starts with. So every
 * colliding subtitle renamed the film too.
 *
 * A YTS release ships `Subs/` named by language ("ara.srt", "fre.srt"), which
 * the renamer cannot tag, so all 32 target one name and collide in turn. On a
 * live library that walked one film to `[dup31]` with no canonical copy left —
 * indistinguishable, from the outside, from "there is a duplicate somewhere".
 * Seven films in that library carried a suffix with no twin beside them.
 */
describe('setAside and sidecars', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'setaside-side-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const seed = async () => {
    await writeFile(path.join(dir, 'Film (2026) - 1080p.mp4'), 'FILM');
    await writeFile(path.join(dir, 'Film (2026) - 1080p.srt'), 'SUB');
  };

  it('moves only the subtitle when a subtitle collides', async () => {
    await seed();

    const to = await setAside(svc(), path.join(dir, 'Film (2026) - 1080p.srt'));

    expect(path.basename(to)).toBe('Film (2026) - 1080p [dup2].srt');
    const after = await readdir(dir);
    // The film keeps its name — this is the whole point.
    expect(after).toContain('Film (2026) - 1080p.mp4');
    expect(after).not.toContain('Film (2026) - 1080p [dup2].mp4');
  });

  it('does not walk the film to a higher suffix across repeated subtitle collisions', async () => {
    await seed();
    // Thirty language files landing on one name, as a YTS Subs/ folder does.
    for (let i = 0; i < 30; i += 1) {
      await setAside(svc(), path.join(dir, 'Film (2026) - 1080p.srt'));
      await writeFile(path.join(dir, 'Film (2026) - 1080p.srt'), `SUB${i}`);
    }

    const after = await readdir(dir);
    expect(after).toContain('Film (2026) - 1080p.mp4');
    expect(after.filter((f) => /\.mp4$/.test(f))).toEqual(['Film (2026) - 1080p.mp4']);
  });

  it('still takes the subtitles along when the VIDEO is the one moved aside', async () => {
    // The behaviour the sweep exists for, and which must survive the fix.
    await seed();
    await writeFile(path.join(dir, 'Film (2026) - 1080p.eng.srt'), 'ENG');
    await writeFile(path.join(dir, 'Film (2026) - 1080p-thumb.jpg'), 'THUMB');

    const to = await setAside(svc(), path.join(dir, 'Film (2026) - 1080p.mp4'));

    expect(path.basename(to)).toBe('Film (2026) - 1080p [dup2].mp4');
    const after = await readdir(dir);
    expect(after.sort()).toEqual([
      'Film (2026) - 1080p [dup2]-thumb.jpg',
      'Film (2026) - 1080p [dup2].eng.srt',
      'Film (2026) - 1080p [dup2].mp4',
      'Film (2026) - 1080p [dup2].srt',
    ].sort());
  });
});
