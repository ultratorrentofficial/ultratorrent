import { BadRequestException } from '@nestjs/common';
import { PATH_TEMPLATE_TOKENS, type PathTemplateToken } from '@ultratorrent/shared';
import { sanitizeSegment } from '../media/media-renamer';
import { nests } from '../media-intake/storage-profile.service';

/**
 * Turning a discovery template's path fragment into a real staging directory.
 *
 * The root is never the template's to choose. It comes from the Storage Profile
 * the template selects, and everything here describes only the LEAF beneath it —
 * which is why there is no `{intake_path}` token and no `{library_path}` token.
 * A generated rule is `managed_intake`, so intake resolves the final destination
 * and organises into the library afterwards; a template that could spell either
 * root would be inverting the pipeline it feeds.
 *
 * Provider titles are untrusted input. Every segment goes through the same
 * `sanitizeSegment` the renamer uses, the result is asserted to stay inside the
 * profile's staging root, and it is refused if it would land inside a destination
 * library — the same conflict `assertManagedSavePathIsStaging` already refuses
 * for hand-made rules, because a staging path inside a library imports that
 * library into itself.
 */

export interface PathTokens {
  title?: string | null;
  tvshow?: string | null;
  movie?: string | null;
  year?: number | null;
  season?: number | null;
  season_number?: number | null;
}

export interface RenderTargetInput {
  /** The Storage Profile's staging root, in canonical space. */
  stagingRoot: string;
  /** The template's leaf fragment, e.g. `TV Shows/{tvshow} ({year})`. */
  pathTemplate: string;
  tokens: PathTokens;
  /** Destination library paths, so staging cannot be placed inside one. */
  libraryPaths?: string[];
}

/**
 * Render one token's value for use in a path segment.
 *
 * A token with no value renders EMPTY rather than as the word "null" or the
 * literal `{year}`. The tidy-up below then removes the punctuation that was only
 * there to frame it, so `{movie} ({year})` with no year gives `Movie` rather than
 * `Movie ()`.
 */
function tokenValue(token: PathTemplateToken, tokens: PathTokens): string {
  const raw =
    token === 'season_number' || token === 'season'
      ? tokens.season_number ?? tokens.season
      : (tokens as Record<string, unknown>)[token];
  if (raw === null || raw === undefined || raw === '') return '';
  // Season numbers are padded to two digits, matching the library layouts the
  // renamer already produces (`Season 01`), so a discovery-created folder and a
  // renamer-created one do not differ by a leading zero.
  if (token === 'season' || token === 'season_number') {
    return String(raw).padStart(2, '0');
  }
  /*
   * The VALUE is sanitised here, before substitution, and that ordering is the
   * whole protection.
   *
   * Substituting first and splitting afterwards lets a separator inside a title
   * invent a directory level: `Face/Off` became `Face/Off` — two segments — and
   * a title of `/etc/cron.d/evil` became three. Separators in the TEMPLATE are
   * structural and must survive; separators in a provider-supplied value are
   * just characters and must not.
   */
  return sanitizeSegment(String(raw));
}

/** Remove framing left empty by a missing token, then collapse whitespace. */
function tidy(segment: string): string {
  return segment
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

/**
 * Render the leaf fragment: sanitise each value, substitute, then split.
 *
 * Values are sanitised BEFORE substitution so a separator inside a title cannot
 * invent a directory level; the template's own separators are split afterwards,
 * because those are structure the operator wrote deliberately.
 */
export function renderPathFragment(pathTemplate: string, tokens: PathTokens): string {
  const unknown = [...pathTemplate.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((t) => !PATH_TEMPLATE_TOKENS.includes(t as PathTemplateToken));
  if (unknown.length) {
    throw new BadRequestException(`Unknown path token(s): ${unknown.map((u) => `{${u}}`).join(', ')}.`);
  }

  const substituted = pathTemplate.replace(/\{([^}]*)\}/g, (_, token: string) =>
    tokenValue(token as PathTemplateToken, tokens),
  );

  const segments = substituted
    .split('/')
    .map((s) => sanitizeSegment(tidy(s)))
    /*
     * Leading dots go too.
     *
     * `sanitizeSegment` trims TRAILING dots but not leading ones, so a title of
     * `../../etc/passwd` sanitises to the contained-but-awful `.... etc passwd`
     * — a directory hidden from `ls` and from most file browsers, which is the
     * last thing an operator hunting for a staging folder needs. No real title
     * begins with a dot.
     */
    .map((s) => s.replace(/^\.+\s*/, '').trim())
    /*
     * `.` and `..` are dropped rather than sanitised into something. Both have
     * already collapsed by this point; this is the belt to that braces, and it is
     * cheap.
     */
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');

  if (!segments.length) {
    throw new BadRequestException('The path template rendered to nothing for this title.');
  }
  return segments.join('/');
}

/**
 * The absolute canonical staging directory for one discovered title.
 *
 * Canonical space, deliberately: translate with
 * `PathMappingRegistryService.toSpace()` before handing it to a container, a
 * download client or a media server.
 */
export function renderTargetPath(input: RenderTargetInput): string {
  const root = input.stagingRoot.trim().replace(/\/+$/, '');
  if (!root.startsWith('/')) {
    throw new BadRequestException('The storage profile has no absolute staging root.');
  }

  const leaf = renderPathFragment(input.pathTemplate, input.tokens);
  const target = `${root}/${leaf}`;

  /*
   * The containment assertion.
   *
   * Every input has already been sanitised, so this should be unreachable — which
   * is exactly why it is here. It is the check that does not depend on the
   * sanitiser being complete, and the one that turns a future gap in the
   * sanitiser into a refusal rather than a write outside the storage root.
   */
  if (!nests(target, root)) {
    throw new BadRequestException('The rendered path would fall outside the staging root.');
  }

  /*
   * Staging must not sit inside a destination library.
   *
   * Managed intake places files INTO the library from wherever they landed. If
   * they already landed in that library the placement is library-to-library: the
   * raw release name and the renamed hardlink end up side by side, both scanned,
   * and the library gains a duplicate of everything it imports. The same conflict
   * `assertManagedSavePathIsStaging` refuses for hand-made rules.
   */
  for (const library of input.libraryPaths ?? []) {
    const lib = library.trim().replace(/\/+$/, '');
    if (!lib) continue;
    if (nests(target, lib)) {
      throw new BadRequestException(
        `The rendered path would sit inside the library at ${lib}. Staging must be outside every destination library.`,
      );
    }
  }

  return target;
}
