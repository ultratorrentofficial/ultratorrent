/**
 * The viewer-facing "your stream was stopped" message, localized.
 *
 * Automatic enforcement has no HTTP request to carry a locale (unlike the manual
 * action, whose text the frontend supplies), so the string is built here. Kept in
 * a small per-locale table — not inlined — so en-US and es-PR both exist and
 * adding a locale is a one-line change. `{limit}` is interpolated.
 */
const TEMPLATES: Record<string, (limit: number) => string> = {
  'en-US': (limit) =>
    `Playback stopped by UltraTorrent.\n\nThis account allows a maximum of ${limit} simultaneous streams.`,
  'es-PR': (limit) =>
    `La reproducción fue detenida por UltraTorrent.\n\nEsta cuenta permite un máximo de ${limit} reproducciones simultáneas.`,
};

export const STREAM_LIMIT_LOCALES = Object.keys(TEMPLATES);

export function limitReachedMessage(limit: number, locale = 'en-US'): string {
  return (TEMPLATES[locale] ?? TEMPLATES['en-US'])(limit);
}
