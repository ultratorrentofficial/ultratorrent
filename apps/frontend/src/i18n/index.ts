import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// --- Static resource bundles -------------------------------------------------
// Resources are imported and bundled (no HTTP backend) so i18n is ready
// synchronously — the app works offline and the keys are type-checked.
import enCommon from './locales/en-US/common.json';
import enNav from './locales/en-US/nav.json';
import enAuth from './locales/en-US/auth.json';
import enShell from './locales/en-US/shell.json';
import enMedia from './locales/en-US/media.json';
import enImdb from './locales/en-US/imdb.json';
import esCommon from './locales/es-PR/common.json';
import esNav from './locales/es-PR/nav.json';
import esAuth from './locales/es-PR/auth.json';
import esShell from './locales/es-PR/shell.json';
import esMedia from './locales/es-PR/media.json';
import esImdb from './locales/es-PR/imdb.json';

/**
 * i18n key conventions (read this before adding strings)
 * ------------------------------------------------------
 * - One namespace per feature surface. Registered now:
 *     common  — generic reusable strings (buttons, feedback defaults)
 *     nav     — sidebar group titles + item labels (keyed by canonical English)
 *     auth    — the login / authentication screens
 *     shell   — app chrome: top bar, sidebar, About dialog, connection status
 *   Planned future namespaces (add the JSON pair + register below when the
 *   matching surface is migrated — do NOT create them empty):
 *     dashboard, torrents, rss, files, automation, media, imdb, settings,
 *     users, audit, engines, system, errors
 * - Keys are dot-nested by section, camelCase leaves:
 *     `t('about.copyright', { ns: 'shell' })`  ->  shell.json > about.copyright
 * - Interpolation uses {{var}}:  t('about.copyright', { year })
 * - `nav` is special: it is keyed by the CANONICAL ENGLISH string so that the
 *   pure `NAV_GROUPS` data structure (asserted on by navigation.test.ts) stays
 *   in English while the shell/breadcrumbs translate at RENDER time via
 *   `t(`groups.${title}`)` / `t(`items.${label}`)`.
 * - Every key MUST ship both en-US and es-PR (es-PR = Latin American / Puerto
 *   Rican Spanish, natural and professional). en-US is the fallback.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en-US', label: 'English' },
  { code: 'es-PR', label: 'Español' },
] as const;

export const NAMESPACES = ['common', 'nav', 'auth', 'shell', 'media', 'imdb'] as const;

export const resources = {
  'en-US': {
    common: enCommon,
    nav: enNav,
    auth: enAuth,
    shell: enShell,
    media: enMedia,
    imdb: enImdb,
  },
  'es-PR': {
    common: esCommon,
    nav: esNav,
    auth: esAuth,
    shell: esShell,
    media: esMedia,
    imdb: esImdb,
  },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // Map any Spanish variant a browser might report (es, es-ES, es-419, …) to
    // our regioned es-PR bundle; everything else falls back to en-US.
    fallbackLng: {
      es: ['es-PR'],
      'es-ES': ['es-PR'],
      'es-419': ['es-PR'],
      default: ['en-US'],
    },
    supportedLngs: ['en-US', 'es-PR'],
    defaultNS: 'common',
    ns: NAMESPACES as unknown as string[],
    interpolation: {
      // React already escapes values, so i18next must not double-escape.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'ultratorrent.lang',
      caches: ['localStorage'],
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
