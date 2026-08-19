/**
 * The standard-mode guardrail.
 *
 * Saving a manual download inside a library that auto-organizes is what stranded
 * *Inglourious Basterds*: the post-download rename moved the video into its own
 * folder, dropped the torrent it could no longer seed, and left the release's
 * subtitles behind. The warning never blocks — doing it deliberately is
 * legitimate — but it has to fire on the paths that actually cause it and stay
 * quiet on the ones that look similar.
 */
import { describe, expect, it } from 'vitest';
import type { MediaLibrary } from '@/lib/api';
import {
  isWithin,
  normalizeSubfolder,
  organizingLibraryFor,
  stagingPreviewPath,
} from './AddTorrentDialog';

const library = (over: Partial<MediaLibrary>): MediaLibrary =>
  ({ id: 'l1', name: 'HD Movies', path: '/downloads/Movies/HD Movies', autoOrganize: true, ...over }) as MediaLibrary;

describe('isWithin', () => {
  it('matches a folder inside the library', () => {
    expect(isWithin('/downloads/Movies/HD Movies/Some Film (2009)', '/downloads/Movies/HD Movies')).toBe(true);
  });

  it('matches the library root itself', () => {
    expect(isWithin('/downloads/Movies/HD Movies', '/downloads/Movies/HD Movies')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // The bug this guards: `/downloads/Movies HD` is not inside `/downloads/Movies`.
    expect(isWithin('/downloads/Movies HD', '/downloads/Movies')).toBe(false);
  });

  it('ignores trailing slashes on either side', () => {
    // A path picker and a stored library path disagree about these routinely.
    expect(isWithin('/downloads/Movies/HD Movies/', '/downloads/Movies/HD Movies')).toBe(true);
  });

  it('is false for an empty path rather than matching everything', () => {
    expect(isWithin('', '/downloads')).toBe(false);
    expect(isWithin('/downloads', '')).toBe(false);
  });
});

describe('organizingLibraryFor', () => {
  it('finds the library that will reorganise the download', () => {
    expect(
      organizingLibraryFor('/downloads/Movies/HD Movies/Some Film (2009)', [library({})])?.name,
    ).toBe('HD Movies');
  });

  it('stays quiet for a library that does not auto-organize', () => {
    // Without autoOrganize nothing moves the file, so there is nothing to warn about.
    expect(organizingLibraryFor('/downloads/Movies/HD Movies', [library({ autoOrganize: false })]))
      .toBeUndefined();
  });

  it('stays quiet for a path outside every library', () => {
    expect(organizingLibraryFor('/downloads/Intake/Movies', [library({})])).toBeUndefined();
  });

  it('reports the deepest library when they nest', () => {
    // The outermost would name a library that is not the one doing the renaming.
    const outer = library({ id: 'l0', name: 'Movies', path: '/downloads/Movies' });
    expect(
      organizingLibraryFor('/downloads/Movies/HD Movies/Some Film (2009)', [outer, library({})])?.name,
    ).toBe('HD Movies');
  });

  it('stays quiet before the libraries have loaded', () => {
    expect(organizingLibraryFor('/downloads/Movies/HD Movies', undefined)).toBeUndefined();
  });
});

describe('the managed-intake staging subfolder', () => {
  it('reads a folder name the same however the operator types the slashes', () => {
    expect(normalizeSubfolder('manual')).toBe('manual');
    expect(normalizeSubfolder('  /manual/  ')).toBe('manual');
    expect(normalizeSubfolder('manual/4k/')).toBe('manual/4k');
  });

  it('is empty when nothing was typed, so the root is used as-is', () => {
    expect(normalizeSubfolder('   ')).toBe('');
    expect(stagingPreviewPath('/downloads/Intake/Movies', '')).toBe('/downloads/Intake/Movies');
  });

  it('previews the path the server will build', () => {
    expect(stagingPreviewPath('/downloads/Intake/Movies', 'manual'))
      .toBe('/downloads/Intake/Movies/manual');
  });

  it('does not double the separator when the root carries a trailing slash', () => {
    // The profile root is operator-typed, so it arrives both ways.
    expect(stagingPreviewPath('/downloads/Intake/Movies/', '/manual'))
      .toBe('/downloads/Intake/Movies/manual');
  });
});
