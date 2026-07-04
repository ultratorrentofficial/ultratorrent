import 'i18next';
import type common from './locales/en-US/common.json';
import type nav from './locales/en-US/nav.json';
import type auth from './locales/en-US/auth.json';
import type shell from './locales/en-US/shell.json';
import type media from './locales/en-US/media.json';
import type imdb from './locales/en-US/imdb.json';

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
      imdb: typeof imdb;
    };
  }
}
