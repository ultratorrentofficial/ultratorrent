import { ForbiddenException, BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
import { PathSafety } from './path-safety';

/**
 * Adversarial input against the containment gate.
 *
 * `path-safety.spec.ts` covers the ordinary properties — traversal, absolute
 * paths, null bytes, system directories — and `path-safety-symlink.spec.ts`
 * covers escape through a link. This file covers the encodings an attacker
 * reaches for once the obvious `../` is known to fail, and exists because 68
 * `js/path-injection` alerts rest on the claim that this class is sound. A claim
 * that large deserves to be tested rather than asserted.
 *
 * Every case must end in exactly one of two ways: contained inside a root, or
 * refused. Never "resolved somewhere else".
 */
const ROOT = path.resolve('/srv/media');
const safety = new PathSafety([ROOT]);

/** Contained, or refused. There is no third acceptable outcome. */
function assertContainedOrRefused(input: string) {
  let resolved: string;
  try {
    resolved = safety.resolveLogical(input);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return;
  }
  expect(resolved === ROOT || resolved.startsWith(ROOT + path.sep)).toBe(true);
}

describe('encoded and obfuscated traversal', () => {
  /*
   * Percent-encoding is decoded by the HTTP layer before a handler sees it, so
   * by here `%2e%2e` is either already `..` (and normalised away by
   * path.resolve) or a literal filename (which is inert). Both are contained;
   * asserted so a future change to the decoding layer cannot quietly alter it.
   */
  it.each([
    '%2e%2e%2f%2e%2e%2fetc/passwd',
    '..%2f..%2fetc/passwd',
    '%252e%252e%252f',
    '..%c0%af..%c0%afetc',
    '%2e%2e/%2e%2e/etc',
  ])('contains percent-encoded traversal: %s', (input) => {
    assertContainedOrRefused(input);
  });

  it.each([
    '....//....//etc/passwd',
    '.../.../etc',
    '..;/..;/etc',
    './././../../../etc',
    'a/b/../../../../../../etc/passwd',
  ])('contains dot-sequence tricks: %s', (input) => {
    assertContainedOrRefused(input);
  });

  /*
   * A backslash is an ordinary filename character on POSIX, where this runs in
   * every supported deployment. It must not be treated as a separator, and it
   * must not escape either.
   */
  it.each([
    '..\\..\\etc\\passwd',
    'a\\..\\..\\etc',
    '\\\\server\\share',
    'C:\\Windows\\System32',
  ])('contains windows-style separators on POSIX: %s', (input) => {
    assertContainedOrRefused(input);
  });

  it.each([
    '/etc/passwd',
    '//etc/passwd',
    '///etc/passwd',
    '/srv/media/../../../etc/passwd',
    '/srv/media-other/secret',
    '/srv/mediaXXX/secret',
  ])('contains absolute and sibling-prefix paths: %s', (input) => {
    assertContainedOrRefused(input);
  });

  /* Unicode separators and invisibles are filename characters, not separators. */
  it.each([
    '..\u2044..\u2044etc',
    'a\u200b/../../etc',
    '\uff0e\uff0e/\uff0e\uff0e/etc',
    '..\u0000/etc',
  ])('contains unicode lookalikes and control characters: %s', (input) => {
    assertContainedOrRefused(input);
  });

  it('refuses a null byte outright rather than truncating at it', () => {
    expect(() => safety.resolveLogical('/movies/a\0/../../etc')).toThrow(BadRequestException);
  });

  it('contains a pathologically long input without escaping', () => {
    assertContainedOrRefused(`${'../'.repeat(5000)}etc/passwd`);
    assertContainedOrRefused('a/'.repeat(10000));
  });

  it.each(['', '/', '.', '..', './', '../'])('handles the degenerate input %p', (input) => {
    assertContainedOrRefused(input);
  });
});

/**
 * The multi-root form takes absolute paths on the wire, which is a wider door:
 * containment is the only thing standing between a request and the filesystem.
 */
describe('multi-root containment', () => {
  const A = path.resolve('/srv/media');
  const B = path.resolve('/mnt/orico');
  const multi = new PathSafety([A, B]);

  it('accepts a path in either root', () => {
    expect(multi.resolveLogical(`${A}/TV`)).toBe(`${A}/TV`);
    expect(multi.resolveLogical(`${B}/TV`)).toBe(`${B}/TV`);
  });

  it.each([
    '/etc/passwd',
    '/srv/media-other/x',
    '/mnt/oricoXXX/x',
    '/srv/media/../../etc/passwd',
    '/mnt/orico/../../etc/shadow',
    'relative/not/absolute',
  ])('refuses or contains %s', (input) => {
    let resolved: string;
    try {
      resolved = multi.resolveLogical(input);
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      return;
    }
    const ok = [A, B].some((r) => resolved === r || resolved.startsWith(r + path.sep));
    expect(ok).toBe(true);
  });

  /*
   * The prefix case that a naive `startsWith(root)` gets wrong: `/srv/mediaXXX`
   * starts with `/srv/media` as a STRING but is a different directory.
   */
  it('does not confuse a sibling whose name extends a root', () => {
    expect(() => multi.resolveLogical('/srv/mediaXXX/secret')).toThrow(ForbiddenException);
    expect(multi.rootFor('/srv/mediaXXX/secret')).toBeUndefined();
  });
});

describe('containment holds for the derived-path helpers too', () => {
  it('ensureContained refuses an outside path without re-basing it', () => {
    expect(() => safety.ensureContained('/etc/passwd')).toThrow(ForbiddenException);
    expect(() => safety.ensureContained(`${ROOT}/../../etc`)).toThrow(ForbiddenException);
    expect(safety.ensureContained(`${ROOT}/ok.mkv`)).toBe(`${ROOT}/ok.mkv`);
  });

  it('relativeToRoot refuses a path the root does not contain', () => {
    expect(() => safety.relativeToRoot(ROOT, '/etc/passwd')).toThrow(ForbiddenException);
    expect(safety.relativeToRoot(ROOT, `${ROOT}/TV/x.mkv`)).toBe('/TV/x.mkv');
  });

  it('toRelative refuses rather than emitting a ..-escaping string', () => {
    expect(() => safety.toRelative('/etc/passwd')).toThrow(ForbiddenException);
  });
});
