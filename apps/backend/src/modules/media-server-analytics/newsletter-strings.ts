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
    upcomingTvTitle: 'Premiering Soon',
    shows: 'Shows',
    showOne: 'Show',
    episodes: 'Episodes',
    episodeOne: 'Episode',
    movies: 'Movies',
    movieOne: 'Movie',
    items: 'Items',
    itemOne: 'Item',
    premieres: 'Premieres',
    premiereOne: 'Premiere',
    premieresOn: 'Premieres {{date}}',
    seasonsOne: 'Season {{n}}',
    seasonsRange: 'Seasons {{a}}–{{b}}',
    empty: 'No new media was added in this period.',
    emptyUpcoming: 'Nothing new starts airing in this window.',
    unrated: 'Unrated',
    unsubscribe: 'Unsubscribe from this newsletter',
    docs: 'Documentation',
    docsNote: 'Guides, setup and reference.',
    sourceCode: 'Source code',
    sourceCodeNote: 'Open source — stars and issues welcome.',
    tagline: 'Your media, beautifully organized.',
    poweredBy: 'Powered by',
    and: 'and',
  },
  'es-PR': {
    brandTitle: 'BOLETÍN DE ULTRATORRENT',
    tvShowsTitle: 'Series Agregadas Recientemente',
    moviesTitle: 'Películas Agregadas Recientemente',
    musicTitle: 'Música y Conciertos Agregados Recientemente',
    documentariesTitle: 'Documentales Agregados Recientemente',
    otherTitle: 'Agregado Recientemente',
    upcomingTvTitle: 'Próximos Estrenos',
    shows: 'Series',
    showOne: 'Serie',
    episodes: 'Episodios',
    episodeOne: 'Episodio',
    movies: 'Películas',
    movieOne: 'Película',
    items: 'Elementos',
    itemOne: 'Elemento',
    premieres: 'Estrenos',
    premiereOne: 'Estreno',
    premieresOn: 'Se estrena el {{date}}',
    seasonsOne: 'Temporada {{n}}',
    seasonsRange: 'Temporadas {{a}}–{{b}}',
    empty: 'No se agregó contenido nuevo en este período.',
    emptyUpcoming: 'No hay estrenos nuevos en este período.',
    unrated: 'Sin calificación',
    unsubscribe: 'Cancelar la suscripción a este boletín',
    docs: 'Documentación',
    docsNote: 'Guías, instalación y referencia.',
    sourceCode: 'Código fuente',
    sourceCodeNote: 'Código abierto — estrellas y reportes bienvenidos.',
    tagline: 'Tus medios, bellamente organizados.',
    poweredBy: 'Desarrollado con',
    and: 'y',
  },
};

export function newsletterStrings(lang?: string | null): NewsletterStrings {
  return NEWSLETTER_STRINGS[lang === 'es-PR' ? 'es-PR' : 'en-US'];
}
