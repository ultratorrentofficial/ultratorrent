import { describe, expect, it } from 'vitest';
import { crumbsFor } from './Breadcrumbs';

describe('crumbsFor', () => {
  it('builds Group › Item for a top-level route', () => {
    expect(crumbsFor('/dashboard')).toEqual([
      { label: 'Overview' },
      { label: 'Dashboard', to: '/dashboard' },
    ]);
  });

  it('resolves the base Torrents route (query ignored)', () => {
    expect(crumbsFor('/torrents')).toEqual([
      { label: 'Downloads' },
      { label: 'Torrents', to: '/torrents' },
    ]);
  });

  it('builds Group › Parent › Item for a nested sub-menu route', () => {
    expect(crumbsFor('/media-acquisition/dashboard')).toEqual([
      { label: 'RSS & Acquisition' },
      { label: 'Acquisition Intelligence', to: '/media-acquisition' },
      { label: 'Smart Download', to: '/media-acquisition/dashboard' },
    ]);
  });

  it('appends a detail crumb for a nested detail route', () => {
    expect(crumbsFor('/rss/rules/abc123')).toEqual([
      { label: 'RSS & Acquisition' },
      { label: 'RSS Feeds', to: '/rss' },
      { label: 'Rule' },
    ]);
  });

  it('appends a generic Details crumb for a media item detail page', () => {
    expect(crumbsFor('/media/items/abc123')).toEqual([
      { label: 'Media Management' },
      { label: 'Media Items', to: '/media/items' },
      { label: 'Details' },
    ]);
  });

  it('resolves /account to the Account group Profile entry', () => {
    expect(crumbsFor('/account')).toEqual([
      { label: 'Account' },
      { label: 'Profile', to: '/account' },
    ]);
  });

  it('falls back to a capitalized segment for unknown routes', () => {
    expect(crumbsFor('/mystery')).toEqual([{ label: 'Mystery' }]);
  });

  it('returns nothing for the root', () => {
    expect(crumbsFor('/')).toEqual([]);
  });
});
