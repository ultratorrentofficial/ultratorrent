import 'i18next';
import type common from './locales/en-US/common.json';
import type nav from './locales/en-US/nav.json';
import type auth from './locales/en-US/auth.json';
import type shell from './locales/en-US/shell.json';
import type media from './locales/en-US/media.json';
import type mediaServerAnalytics from './locales/en-US/mediaServerAnalytics.json';
import type notificationCenter from './locales/en-US/notificationCenter.json';
import type subtitleIntelligence from './locales/en-US/subtitleIntelligence.json';
import type imdb from './locales/en-US/imdb.json';
import type rss from './locales/en-US/rss.json';
import type torrents from './locales/en-US/torrents.json';
import type files from './locales/en-US/files.json';
import type automation from './locales/en-US/automation.json';
import type settings from './locales/en-US/settings.json';
import type users from './locales/en-US/users.json';
import type modules from './locales/en-US/modules.json';
import type engines from './locales/en-US/engines.json';
import type indexers from './locales/en-US/indexers.json';
import type prowlarr from './locales/en-US/prowlarr.json';
import type audit from './locales/en-US/audit.json';
import type jobs from './locales/en-US/jobs.json';
import type dashboard from './locales/en-US/dashboard.json';
import type account from './locales/en-US/account.json';
import type system from './locales/en-US/system.json';

// Type the default namespace + resource shape so `t()` keys are checked against
// the en-US bundles (the canonical shape). Both languages share this shape.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof common;
      nav: typeof nav;
      auth: typeof auth;
      shell: typeof shell;
      media: typeof media;
      mediaServerAnalytics: typeof mediaServerAnalytics;
      notificationCenter: typeof notificationCenter;
      subtitleIntelligence: typeof subtitleIntelligence;
      imdb: typeof imdb;
      rss: typeof rss;
      torrents: typeof torrents;
      files: typeof files;
      automation: typeof automation;
      settings: typeof settings;
      users: typeof users;
      modules: typeof modules;
      engines: typeof engines;
      indexers: typeof indexers;
      prowlarr: typeof prowlarr;
      audit: typeof audit;
      jobs: typeof jobs;
      dashboard: typeof dashboard;
      account: typeof account;
      system: typeof system;
    };
  }
}
