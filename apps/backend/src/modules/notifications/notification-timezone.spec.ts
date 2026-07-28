/**
 * Notifications render in the recipient's timezone.
 *
 * This is the half of the feature that was genuinely broken. The web UI has
 * always formatted in the browser's zone, so it was roughly right by accident;
 * Telegram, Discord and email are rendered **server-side**, where the dispatcher
 * passed `timezone: null`. `Intl` then falls back to the host clock — UTC in a
 * container — so every external alert carried a time that was right for nobody,
 * with no browser downstream to correct it.
 */
import { formatWhen } from './presentation/presentation-strings';
import { isValidTimezone, normalizeTimezone } from '@ultratorrent/shared';

/** 2026-07-28T02:30:00Z — deliberately a moment that falls on the PREVIOUS day
 *  in the Americas, so a wrong zone shows up as the wrong DATE, not just a
 *  shifted clock. */
const LATE_NIGHT_UTC = '2026-07-28T02:30:00.000Z';

describe('formatWhen honours the recipient zone', () => {
  it('renders the same instant differently for different people', () => {
    const puertoRico = formatWhen(LATE_NIGHT_UTC, 'en-US', 'America/Puerto_Rico');
    const madrid = formatWhen(LATE_NIGHT_UTC, 'en-US', 'Europe/Madrid');
    expect(puertoRico).not.toEqual(madrid);
  });

  it('rolls the DATE back for a zone behind UTC, not just the clock', () => {
    /*
     * 02:30 UTC is still Jul 27 in Puerto Rico. A viewer there being told an
     * alert happened on the 28th is the failure this feature exists to fix.
     *
     * `now` is passed explicitly and set weeks later: formatWhen renders recent
     * moments as "Today"/"Yesterday", which carries no date to assert on.
     */
    const later = new Date('2026-08-15T12:00:00.000Z');
    expect(formatWhen(LATE_NIGHT_UTC, 'en-US', 'America/Puerto_Rico', later)).toMatch(/27/);
    expect(formatWhen(LATE_NIGHT_UTC, 'en-US', 'UTC', later)).toMatch(/28/);
  });

  it('falls back to the host clock when no zone is stored', () => {
    // `null` is "follow the device"; server-side there is no device, so this is
    // the old behaviour — now reached only when nothing better is known.
    expect(() => formatWhen(LATE_NIGHT_UTC, 'en-US', null)).not.toThrow();
    expect(formatWhen(LATE_NIGHT_UTC, 'en-US', null)).not.toEqual('');
  });

  it('degrades to the host clock rather than throwing on a bad zone', () => {
    /*
     * A stored zone can go stale: IANA renames zones, and a value written by an
     * older runtime may be unknown to this one. An alert must still be sent —
     * a wrong-but-present time beats a delivery that fails.
     */
    expect(() => formatWhen(LATE_NIGHT_UTC, 'en-US', 'Mars/Olympus_Mons')).not.toThrow();
    expect(formatWhen(LATE_NIGHT_UTC, 'en-US', 'Mars/Olympus_Mons')).not.toEqual('');
  });

  it('returns empty for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatWhen('not-a-date', 'en-US', 'UTC')).toEqual('');
  });
});

describe('timezone validation', () => {
  it('accepts real IANA zones', () => {
    for (const tz of ['America/Puerto_Rico', 'Europe/Madrid', 'UTC', 'Asia/Tokyo']) {
      expect(isValidTimezone(tz)).toBe(true);
    }
  });

  it('rejects offsets, which are not identities', () => {
    /*
     * `-04:00` is Puerto Rico all year and New York only in summer. Storing an
     * offset would render half the year wrong anywhere that observes DST.
     */
    // `Intl` itself ACCEPTS these; we reject them deliberately.
    for (const offset of ['-04:00', '+0530', 'GMT-4', 'UTC+2', '-4']) {
      expect(isValidTimezone(offset)).toBe(false);
    }
    // A named Etc zone is a real IANA entry with rules, and stays valid.
    expect(isValidTimezone('Etc/GMT+5')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects nonsense and non-strings', () => {
    for (const bad of ['', '   ', 'Nowhere/Nothing', 42, {}, [], true]) {
      expect(isValidTimezone(bad)).toBe(false);
    }
  });

  it('treats null, empty and "auto" as follow-the-device', () => {
    // Three inputs the UI may naturally send; they must not become three
    // different stored states.
    for (const auto of [null, undefined, '', '   ', 'auto', 'AUTO']) {
      expect(normalizeTimezone(auto)).toBeNull();
    }
  });

  it('rejects an unknown zone instead of silently storing null', () => {
    // Quietly discarding a mistyped zone leaves the user believing they set one.
    expect(normalizeTimezone('Mars/Olympus_Mons')).toBeUndefined();
    expect(normalizeTimezone(42)).toBeUndefined();
  });

  it('passes a valid zone through, trimmed', () => {
    expect(normalizeTimezone('  Europe/Madrid  ')).toBe('Europe/Madrid');
  });
});
