import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

/**
 * UltraTorrent documentation site.
 *
 * Why Docusaurus 3 (over VitePress / MkDocs Material / Starlight): this repo is
 * already a TypeScript + React monorepo, and Docusaurus ships first-class
 * **versioning** and **i18n** — the two hardest requirements — without bolt-ons.
 *
 * Why local search (not Algolia): UltraTorrent is self-hosted and its users may be
 * air-gapped. `@easyops-cn/docusaurus-search-local` indexes at build time, needs no
 * account or API key, and works fully offline.
 *
 * The site lives in `website/` and is deliberately NOT an npm workspace — the root
 * `build` script names shared/backend/frontend explicitly, so the docs can never
 * break the application build.
 */
const config: Config = {
  title: 'UltraTorrent',
  tagline: 'Self-hosted Media Acquisition & Management Platform',
  favicon: 'img/favicon.ico',

  // The same content ships to three places, which need different base paths:
  //   • docs.ultratorrent.co → served at the root (the canonical site, default)
  //   • the app image        → served by the frontend container at /docs/, offline
  //   • GitHub Pages         → https://ultratorrentofficial.github.io/ultratorrent/
  // All env-driven. Set DOCS_BASE_URL=/docs/ for the in-app build, or
  // DOCS_URL=https://ultratorrentofficial.github.io DOCS_BASE_URL=/ultratorrent/ for Pages.
  //
  // The default is the canonical site deliberately: a plain `npm run docs:build`
  // previously produced a site whose every link pointed at /ultratorrent/,
  // which renders but navigates nowhere — a silent failure that is easy to ship.
  url: process.env.DOCS_URL ?? 'https://docs.ultratorrent.co',
  baseUrl: process.env.DOCS_BASE_URL ?? '/',
  organizationName: 'ultratorrentofficial',
  projectName: 'ultratorrent',
  trailingSlash: false,

  // The docs are heavily cross-linked, so a dangling internal link — or a link to
  // a heading that has since been renamed — is a bug. Fail the build on both.
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  // --- Localization -------------------------------------------------------
  // English + Spanish (Puerto Rico), mirroring the application's own locales.
  // Adding a language later = one entry here + an `i18n/<locale>/` tree.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es-PR'],
    localeConfigs: {
      en: { label: 'English', direction: 'ltr', htmlLang: 'en-US' },
      'es-PR': { label: 'Español (Puerto Rico)', direction: 'ltr', htmlLang: 'es-PR' },
    },
  },
  // Build ALL locales in one `docusaurus build` (npm run build:all), never one
  // `--locale` pass per locale. A single-locale build treats that locale as the
  // only one and emits the language switcher without a locale prefix: the English
  // page linked "Español (Puerto Rico)" to `/` instead of `/es-PR/`, so switching
  // language silently did nothing. --out-dir puts the files in the right place;
  // it does not tell the other build they exist.
  //
  // The split existed because two locales at once OOM'd the old 1.6 GB dev box.
  // Measured on the current host: 5.0 GB peak of 7.4 GB. build:en / build:es-PR
  // are kept for genuinely memory-constrained or single-locale builds — accepting
  // that the switcher is broken in that output.

  // --- Build performance --------------------------------------------------
  // Rspack + SWC + Lightning CSS instead of webpack/Babel/PostCSS. This is not a
  // nicety: the default toolchain needs several GB of JS heap to render 70+ pages
  // with ~100 Mermaid diagrams across two locales, which OOMs on a small VPS.
  future: {
    faster: true,
    // `faster` renders pages in SSG worker threads, which requires this v4 flag.
    v4: { removeLegacyPostBuildHeadAttribute: true },
  },

  // --- Diagrams -----------------------------------------------------------
  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        language: ['en', 'es'],
      },
    ],
  ],

  plugins: [
    // Click-to-zoom on every screenshot and diagram.
    [
      'docusaurus-plugin-image-zoom',
      { selector: '.markdown img', background: { light: '#f8f9fa', dark: '#1b1b1d' } },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/', // the docs *are* the site
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/ultratorrentofficial/ultratorrent/tree/main/website/',
          // Derived from git history, so it needs a worktree. The copy baked into
          // the application image is built inside Docker, where `.dockerignore`
          // excludes `.git` — Docusaurus hard-fails there rather than degrading.
          // Off for that build, on everywhere else (dev, CI, GitHub Pages).
          showLastUpdateTime: process.env.DOCS_NO_GIT !== '1',
          breadcrumbs: true,
          // Versioning: `current` is the unreleased doc set (what's on main).
          // Cut a release snapshot with: npm run docusaurus docs:version 0.28
          lastVersion: 'current',
          versions: {
            current: { label: 'Next (main)', path: '' },
          },
        },
        blog: false, // a product doc site, not a blog
        theme: { customCss: './src/css/custom.css' },
        sitemap: { changefreq: 'weekly', priority: 0.5 },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',

    // Dark + light, honouring the visitor's OS preference.
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },

    docs: { sidebar: { hideable: true, autoCollapseCategories: true } },

    // Right-hand table of contents on every page.
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },

    navbar: {
      // Full lockup (mark + wordmark + tagline); no `title` so the name is not
      // repeated next to a logo that already contains it. 640x169 source.
      logo: { alt: 'UltraTorrent', src: 'img/logo.png', width: 182, height: 48 },
      items: [
        { type: 'docSidebar', sidebarId: 'learn', position: 'left', label: 'Learn' },
        { type: 'docSidebar', sidebarId: 'install', position: 'left', label: 'Install' },
        { type: 'docSidebar', sidebarId: 'modules', position: 'left', label: 'Modules' },
        { type: 'docSidebar', sidebarId: 'reference', position: 'left', label: 'Reference' },
        { type: 'docSidebar', sidebarId: 'develop', position: 'left', label: 'Develop' },
        { type: 'docSidebar', sidebarId: 'operate', position: 'left', label: 'Operate' },
        { type: 'docsVersionDropdown', position: 'right' },
        { type: 'localeDropdown', position: 'right' },
        {
          href: 'https://github.com/ultratorrentofficial/ultratorrent',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },

    footer: {
      style: 'dark',
      links: [
        {
          title: 'Learn',
          items: [
            { label: 'Introduction', to: '/' },
            { label: 'Quick Start', to: '/learn/quick-start' },
            { label: 'Core Concepts', to: '/learn/concepts' },
          ],
        },
        {
          title: 'Reference',
          items: [
            { label: 'REST API', to: '/reference/api' },
            { label: 'Permissions', to: '/reference/permissions' },
            { label: 'Environment Variables', to: '/reference/environment' },
            { label: 'Database Schema', to: '/reference/database-schema' },
          ],
        },
        {
          title: 'Help',
          items: [
            { label: 'Troubleshooting', to: '/operate/troubleshooting' },
            { label: 'FAQ', to: '/help/faq' },
            {
              label: 'GitHub Issues',
              href: 'https://github.com/ultratorrentofficial/ultratorrent/issues',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} UltraTorrent.`,
    },

    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: [
        'bash',
        'json',
        'yaml',
        'docker',
        'nginx',
        'typescript',
        'python',
        'powershell',
        'sql',
        'ini',
        'diff',
      ],
    },

    mermaid: { theme: { light: 'neutral', dark: 'dark' } },

    // Read by docusaurus-plugin-image-zoom.
    zoom: { selector: '.markdown :not(em) > img' },
  } satisfies Preset.ThemeConfig,
};

export default config;
