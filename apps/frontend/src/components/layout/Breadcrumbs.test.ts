import { describe, expect, it } from 'vitest';
import { crumbsFor } from './Breadcrumbs';

describe('crumbsFor', () => {
  it('builds Group › Item for a top-level route', () => {
    expect(crumbsFor('/dashboard')).toEqual([
      { label: 'Overview' },
      { label: 'Dashboard', to: '/dashboard' },
    ]);
  });

  it('resolves the base Torrents route to "All Torrents" (query ignored)', () => {
    expect(crumbsFor('/torrents')).toEqual([
      { label: 'Torrents' },
      { label: 'All Torrents', to: '/torrents' },
    ]);
  });

  it('appends a detail crumb for a nested detail route', () => {
    expect(crumbsFor('/rss/rules/abc123')).toEqual([
      { label: 'Automation' },
      { label: 'RSS Feeds', to: '/rss' },
      { label: 'Rule' },
    ]);
  });

  it('handles routes not in the nav via detail labels', () => {
    expect(crumbsFor('/account')).toEqual([{ label: 'Account' }]);
  });

  it('falls back to a capitalized segment for unknown routes', () => {
    expect(crumbsFor('/mystery')).toEqual([{ label: 'Mystery' }]);
  });

  it('returns nothing for the root', () => {
    expect(crumbsFor('/')).toEqual([]);
  });
});
