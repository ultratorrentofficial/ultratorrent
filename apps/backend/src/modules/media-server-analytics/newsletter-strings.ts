import type { NewsletterStrings } from './newsletter-render';

/**
 * Localized newsletter strings. Emails are rendered server-side, so their text
 * can't come from the frontend i18n bundles — this is the newsletter's own
 * translation table. Keep EN and ES key-for-key identical (enforced by tests).
 */
export const NEWSLETTER_STRINGS: Record<'en-US' | 'es-PR', NewsletterStrings> = {
  'en-US': {
    brandTitle: 'ULTRATORRENT NEWSLETTER',
    tvShowsTitle: 'Recently Added TV Shows',
    moviesTitle: 'Recently Added Movies',
    musicTitle: 'Recently Added Music & Concerts',
    documentariesTitle: 'Recently Added Documentaries',
    otherTitle: 'Recently Added',
    shows: 'Shows',
    episodes: 'Episodes',
    movies: 'Movies',
    items: 'Items',
    seasonsOne: 'Season {{n}}',
    seasonsRange: 'Seasons {{a}}–{{b}}',
    empty: 'No new media was added in this period.',
    unrated: 'Unrated',
    unsubscribe: 'Unsubscribe',
    unsubscribeNote: 'Stop receiving this newsletter.',
    preferences: 'Preferences',
    preferencesNote: 'Manage what you receive.',
    tagline: 'Your media, beautifully organized.',
    deliveredBy: 'Delivered by',
  },
  'es-PR': {
    brandTitle: 'BOLETÍN DE ULTRATORRENT',
    tvShowsTitle: 'Series Agregadas Recientemente',
    moviesTitle: 'Películas Agregadas Recientemente',
    musicTitle: 'Música y Conciertos Agregados Recientemente',
    documentariesTitle: 'Documentales Agregados Recientemente',
    otherTitle: 'Agregado Recientemente',
    shows: 'Series',
    episodes: 'Episodios',
    movies: 'Películas',
    items: 'Elementos',
    seasonsOne: 'Temporada {{n}}',
    seasonsRange: 'Temporadas {{a}}–{{b}}',
    empty: 'No se agregó contenido nuevo en este período.',
    unrated: 'Sin calificación',
    unsubscribe: 'Cancelar suscripción',
    unsubscribeNote: 'Deja de recibir este boletín.',
    preferences: 'Preferencias',
    preferencesNote: 'Administra lo que recibes.',
    tagline: 'Tus medios, bellamente organizados.',
    deliveredBy: 'Entregado por',
  },
};

export function newsletterStrings(lang?: string | null): NewsletterStrings {
  return NEWSLETTER_STRINGS[lang === 'es-PR' ? 'es-PR' : 'en-US'];
}
