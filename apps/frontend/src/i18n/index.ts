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
import enMediaServerAnalytics from './locales/en-US/mediaServerAnalytics.json';
import enNotificationCenter from './locales/en-US/notificationCenter.json';
import enSubtitleIntelligence from './locales/en-US/subtitleIntelligence.json';
import enImdb from './locales/en-US/imdb.json';
import enRss from './locales/en-US/rss.json';
import enTorrents from './locales/en-US/torrents.json';
import enFiles from './locales/en-US/files.json';
import enAutomation from './locales/en-US/automation.json';
import enSettings from './locales/en-US/settings.json';
import enUsers from './locales/en-US/users.json';
import enModules from './locales/en-US/modules.json';
import enEngines from './locales/en-US/engines.json';
import enIndexers from './locales/en-US/indexers.json';
import enProwlarr from './locales/en-US/prowlarr.json';
import enAudit from './locales/en-US/audit.json';
import enJobs from './locales/en-US/jobs.json';
import enWorkflows from './locales/en-US/workflows.json';
import enDashboard from './locales/en-US/dashboard.json';
import enAccount from './locales/en-US/account.json';
import enSystem from './locales/en-US/system.json';
import esCommon from './locales/es-PR/common.json';
import esNav from './locales/es-PR/nav.json';
import esAuth from './locales/es-PR/auth.json';
import esShell from './locales/es-PR/shell.json';
import esMedia from './locales/es-PR/media.json';
import esMediaServerAnalytics from './locales/es-PR/mediaServerAnalytics.json';
import esNotificationCenter from './locales/es-PR/notificationCenter.json';
import esSubtitleIntelligence from './locales/es-PR/subtitleIntelligence.json';
import esImdb from './locales/es-PR/imdb.json';
import esRss from './locales/es-PR/rss.json';
import esTorrents from './locales/es-PR/torrents.json';
import esFiles from './locales/es-PR/files.json';
import esAutomation from './locales/es-PR/automation.json';
import esSettings from './locales/es-PR/settings.json';
import esUsers from './locales/es-PR/users.json';
import esModules from './locales/es-PR/modules.json';
import esEngines from './locales/es-PR/engines.json';
import esIndexers from './locales/es-PR/indexers.json';
import esProwlarr from './locales/es-PR/prowlarr.json';
import esAudit from './locales/es-PR/audit.json';
import esJobs from './locales/es-PR/jobs.json';
import esWorkflows from './locales/es-PR/workflows.json';
import esDashboard from './locales/es-PR/dashboard.json';
import esAccount from './locales/es-PR/account.json';
import esSystem from './locales/es-PR/system.json';

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

export const NAMESPACES = [
  'common',
  'nav',
  'auth',
  'shell',
  'media',
  'mediaServerAnalytics',
  'notificationCenter',
  'subtitleIntelligence',
  'imdb',
  'rss',
  'torrents',
  'files',
  'automation',
  'settings',
  'users',
  'modules',
  'engines',
  'indexers',
  'prowlarr',
  'audit',
  'jobs',
  'workflows',
  'dashboard',
  'account',
  'system',
] as const;

export const resources = {
  'en-US': {
    common: enCommon,
    nav: enNav,
    auth: enAuth,
    shell: enShell,
    media: enMedia,
    mediaServerAnalytics: enMediaServerAnalytics,
    notificationCenter: enNotificationCenter,
    subtitleIntelligence: enSubtitleIntelligence,
    imdb: enImdb,
    rss: enRss,
    torrents: enTorrents,
    files: enFiles,
    automation: enAutomation,
    settings: enSettings,
    users: enUsers,
    modules: enModules,
    engines: enEngines,
    indexers: enIndexers,
    prowlarr: enProwlarr,
    audit: enAudit,
    jobs: enJobs,
    workflows: enWorkflows,
    dashboard: enDashboard,
    account: enAccount,
    system: enSystem,
  },
  'es-PR': {
    common: esCommon,
    nav: esNav,
    auth: esAuth,
    shell: esShell,
    media: esMedia,
    mediaServerAnalytics: esMediaServerAnalytics,
    notificationCenter: esNotificationCenter,
    subtitleIntelligence: esSubtitleIntelligence,
    imdb: esImdb,
    rss: esRss,
    torrents: esTorrents,
    files: esFiles,
    automation: esAutomation,
    settings: esSettings,
    users: esUsers,
    modules: esModules,
    engines: esEngines,
    indexers: esIndexers,
    prowlarr: esProwlarr,
    audit: esAudit,
    jobs: esJobs,
    workflows: esWorkflows,
    dashboard: esDashboard,
    account: esAccount,
    system: esSystem,
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
