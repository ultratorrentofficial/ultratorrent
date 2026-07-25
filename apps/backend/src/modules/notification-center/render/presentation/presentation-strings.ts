import type { PresentationLocale } from './presentation.types';

/**
 * Presentation copy, in code rather than the i18n JSON files.
 *
 * The frontend's translation bundles are loaded in the browser; a presentation is
 * built on the server, per recipient, for channels that have no browser at all —
 * an email cannot ask i18next for a string. Keeping the copy beside the builder
 * that uses it also means a new event ships its strings in the same commit,
 * instead of rendering a raw key until someone remembers the JSON.
 *
 * Both locales are required by the type, so adding a string without its Spanish
 * translation fails the build rather than silently falling back to English.
 */
type Copy = Record<PresentationLocale, string>;

export const PRESENTATION_STRINGS = {
  brand: { 'en-US': 'ULTRATORRENT', 'es-PR': 'ULTRATORRENT' } satisfies Copy,

  startedLead: { 'en-US': 'User Started', 'es-PR': 'Usuario comenzó' } satisfies Copy,
  startedTrail: { 'en-US': 'Watching', 'es-PR': 'a ver' } satisfies Copy,
  stoppedLead: { 'en-US': 'User Stopped', 'es-PR': 'Usuario detuvo' } satisfies Copy,
  stoppedTrail: { 'en-US': 'Watching', 'es-PR': 'la reproducción' } satisfies Copy,

  /** `{name}` and `{media}` are substituted; not i18next syntax — see `format()`. */
  startedSummary: {
    'en-US': '{name} started watching {media}',
    'es-PR': '{name} comenzó a ver {media}',
  } satisfies Copy,
  stoppedSummary: {
    'en-US': '{name} stopped watching {media}',
    'es-PR': '{name} dejó de ver {media}',
  } satisfies Copy,

  fieldUser: { 'en-US': 'User', 'es-PR': 'Usuario' } satisfies Copy,
  fieldMedia: { 'en-US': 'Media', 'es-PR': 'Contenido' } satisfies Copy,
  fieldEpisode: { 'en-US': 'Episode', 'es-PR': 'Episodio' } satisfies Copy,
  fieldTime: { 'en-US': 'Time', 'es-PR': 'Hora' } satisfies Copy,
  fieldProgress: { 'en-US': 'Progress', 'es-PR': 'Progreso' } satisfies Copy,

  nowPlaying: { 'en-US': 'Now playing', 'es-PR': 'Reproduciendo ahora' } satisfies Copy,
  paused: { 'en-US': 'Paused', 'es-PR': 'En pausa' } satisfies Copy,

  viewDetails: { 'en-US': 'View details', 'es-PR': 'Ver detalles' } satisfies Copy,
  viewActivity: { 'en-US': 'View activity', 'es-PR': 'Ver actividad' } satisfies Copy,

  /** `{percent}` substituted. */
  percentWatched: { 'en-US': '{percent}% watched', 'es-PR': '{percent}% visto' } satisfies Copy,
  /** `{title}` substituted. */
  posterAlt: { 'en-US': 'Poster for {title}', 'es-PR': 'Póster de {title}' } satisfies Copy,

  today: { 'en-US': 'Today', 'es-PR': 'Hoy' } satisfies Copy,
  /** Someone whose name the media server did not report. */
  someone: { 'en-US': 'Someone', 'es-PR': 'Alguien' } satisfies Copy,
} as const;

export type PresentationStringKey = keyof typeof PRESENTATION_STRINGS;

/** Look up a string and substitute `{placeholders}`. */
export function s(
  key: PresentationStringKey,
  locale: PresentationLocale,
  vars: Record<string, string | number> = {},
): string {
  const template = PRESENTATION_STRINGS[key][locale];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * "Today, 8:24 PM" or "Jul 24, 8:24 PM", in the recipient's timezone.
 *
 * "Today" is resolved by comparing the *rendered* calendar date in that zone —
 * not by subtracting timestamps. A recipient in Puerto Rico reading an event
 * stamped 03:00 UTC should see yesterday's date if that is what their wall clock
 * says, and a 24-hour arithmetic window gets that wrong twice a day.
 *
 * An invalid zone is a stored user preference, not a crash: `Intl` throws on a
 * bad `timeZone`, so we fall back to the server's rather than fail the render.
 */
export function formatWhen(
  iso: string,
  locale: PresentationLocale,
  timezone: string | null,
  now: Date = new Date(),
): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  const dateOpts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

  let dateFmt: Intl.DateTimeFormat;
  let timeFmt: Intl.DateTimeFormat;
  try {
    const tz = timezone ?? undefined;
    dateFmt = new Intl.DateTimeFormat(locale, { ...dateOpts, timeZone: tz });
    timeFmt = new Intl.DateTimeFormat(locale, { ...timeOpts, timeZone: tz });
  } catch {
    dateFmt = new Intl.DateTimeFormat(locale, dateOpts);
    timeFmt = new Intl.DateTimeFormat(locale, timeOpts);
  }

  const time = timeFmt.format(when);
  const day = dateFmt.format(when);
  return day === dateFmt.format(now) ? `${s('today', locale)}, ${time}` : `${day}, ${time}`;
}
