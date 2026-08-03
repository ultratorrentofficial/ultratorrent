import { canTransition, nextState } from '@ultratorrent/shared';
import { stemPrefix } from './intake-post-import.service';

/**
 * A post-import failure must say what went wrong.
 *
 * Live, three intake jobs failed with the same message:
 *
 *     Fetch metadata: Illegal intake transition imported → quarantined
 *
 * which describes the state machine and nothing an operator could act on. Two
 * faults combined to produce it. The metadata stage forms a legitimate
 * quarantine opinion — file placed, no library item for it, no retry will help
 * — but `imported → quarantined` was not a legal edge; and when the refusal
 * threw, the pipeline recorded the REFUSAL as the failure and discarded the
 * stage's reason.
 *
 * Underneath, the item existed all along: intake's own `[dupN]` move-aside had
 * renamed the file, and the lookup was an equality test on the exact path.
 */
describe('quarantine after import', () => {
  it('is a legal move, because the metadata stage can form that opinion', () => {
    expect(canTransition('imported', 'quarantined')).toBe(true);
  });

  it('does not divert the happy path', () => {
    // `nextState` takes the HEAD of the list, so the new edge must come second
    // or every import would advance straight into quarantine.
    expect(nextState('imported')).toBe('metadata_ready');
  });

  it('stays closed for stages that cannot form the opinion', () => {
    // Only the metadata stage quarantines after import. The principle in the
    // state table — a stage that cannot form the opinion must not claim it —
    // still holds for the rest.
    expect(canTransition('metadata_ready', 'quarantined')).toBe(false);
    expect(canTransition('artwork_ready', 'quarantined')).toBe(false);
    expect(canTransition('subtitle_ready', 'quarantined')).toBe(false);
  });
});

describe('stemPrefix', () => {
  it('matches a file that intake later moved aside to [dupN]', () => {
    const placed = '/lib/Evolution (2026)/Evolution (2026) - 1080p.mp4';
    const actual = '/lib/Evolution (2026)/Evolution (2026) - 1080p [dup2].mp4';
    expect(actual.startsWith(stemPrefix(placed))).toBe(true);
  });

  it('matches the same name with a different extension', () => {
    const placed = '/lib/Film (2026)/Film (2026) - 1080p.mp4';
    expect('/lib/Film (2026)/Film (2026) - 1080p.mkv'.startsWith(stemPrefix(placed))).toBe(true);
  });

  it('does NOT match a different episode in the same season folder', () => {
    // Why this is a stem and not the bare directory.
    const placed = '/lib/Show (2020)/Season 01/Show - S01E01 - Pilot.mkv';
    const other = '/lib/Show (2020)/Season 01/Show - S01E02 - Second.mkv';
    expect(other.startsWith(stemPrefix(placed))).toBe(false);
  });

  it('leaves a path with no extension alone', () => {
    expect(stemPrefix('/lib/Film (2026)/Film (2026)')).toBe('/lib/Film (2026)/Film (2026)');
  });

  it('does not mistake a dot in a folder name for an extension', () => {
    const p = '/lib/Film 2.0 (2026)/Film 2.0 (2026) - 1080p.mp4';
    expect(stemPrefix(p)).toBe('/lib/Film 2.0 (2026)/Film 2.0 (2026) - 1080p');
  });
});
