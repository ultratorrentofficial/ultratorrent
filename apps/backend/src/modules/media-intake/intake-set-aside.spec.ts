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
