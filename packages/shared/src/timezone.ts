/**
 * Display timezone — shared, because both sides must agree on what is valid.
 *
 * A stored timezone is an **IANA zone name** (`America/Puerto_Rico`,
 * `Europe/Madrid`), never a UTC offset. Offsets are not identities: `-04:00` is
 * Puerto Rico all year and New York only in summer, so storing one would render
 * half the year wrong for anywhere that observes daylight saving.
 *
 * `null` means **follow the device**, which is what every account has until
 * someone chooses otherwise. It is a real answer rather than a missing one: on
 * the web it is usually what a person wants, and it keeps existing behaviour
 * exactly as it was.
 */

/** Stored value: an IANA zone, or `null` for "follow the device". */
export type DisplayTimezone = string | null;

/**
 * Is this a timezone the runtime can actually format with?
 *
 * Asks `Intl` rather than checking a list. The set of zones changes — IANA
 * publishes several releases a year, and Node ships new ones with ICU updates —
 * so a hardcoded list would start rejecting valid zones and would have to be
 * maintained forever. Constructing a formatter is the only answer that stays
 * true to what this runtime can render.
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  const candidate = value.trim();

  /*
   * Reject bare offsets even though `Intl` accepts them.
   *
   * Modern engines take `-04:00` and `GMT-4` as valid `timeZone` values, but an
   * offset is not an identity: `-04:00` is Puerto Rico all year and New York
   * only in summer. Storing one would render half the year wrong for anywhere
   * observing daylight saving — and it would do so silently, months after the
   * setting was chosen. Named `Etc/GMT+5` zones carry a slash and stay allowed;
   * they are real IANA entries with defined rules.
   */
  if (/^(?:GMT|UTC)?[+-]\d{1,2}(?::?\d{2})?$/i.test(candidate)) return false;

  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise user input into something storable.
 *
 * Empty string, `'auto'` and `null` all mean "follow the device" — the UI sends
 * whichever is natural for its control, and they must not become three
 * different stored states.
 *
 * Returns `undefined` for a value that is neither valid nor a clear "auto",
 * which callers should treat as a rejection rather than silently storing null:
 * quietly discarding a mistyped zone would leave the user believing they had
 * set one.
 */
export function normalizeTimezone(value: unknown): DisplayTimezone | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') return null;

  return isValidTimezone(trimmed) ? trimmed : undefined;
}

/**
 * Every zone this runtime knows, for a picker.
 *
 * `supportedValuesOf` is Node 18+/modern browsers; where it is missing the
 * caller gets an empty list and should fall back to free text rather than an
 * empty dropdown.
 */
export function availableTimezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    return typeof supported === 'function' ? supported.call(Intl, 'timeZone') : [];
  } catch {
    return [];
  }
}

/** The device's own zone, used as the "follow the device" label and fallback. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
