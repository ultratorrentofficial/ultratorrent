import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MediaServerIcon, MEDIA_SERVER_COLOR, isMediaServerKind } from './MediaServerIcon';

const svgOf = (kind: string) => {
  const { container } = render(<MediaServerIcon kind={kind} />);
  return container.querySelector('svg');
};

describe('MediaServerIcon', () => {
  it.each(['plex', 'jellyfin', 'emby', 'kodi'] as const)('renders a mark for %s', (kind) => {
    const svg = svgOf(kind);
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('path, rect, circle').length).toBeGreaterThan(0);
  });

  /**
   * The colour is the identification. If a mark rendered in the theme's
   * foreground it would look like every other icon on the card, which is the
   * problem this component exists to solve.
   */
  it.each([['plex'], ['emby'], ['kodi']] as const)('uses the %s brand colour', (kind) => {
    const svg = svgOf(kind);
    expect(svg!.innerHTML).toContain(MEDIA_SERVER_COLOR[kind]);
  });

  it('gives Jellyfin its gradient rather than a flat fill', () => {
    const svg = svgOf('jellyfin');
    expect(svg!.querySelector('linearGradient')).not.toBeNull();
    expect(svg!.innerHTML).toContain('#AA5CC3');
    expect(svg!.innerHTML).toContain('#00A4DC');
  });

  it('renders nothing for a kind it does not know', () => {
    expect(svgOf('unraid-media-thing')).toBeNull();
    expect(svgOf('')).toBeNull();
  });

  it('is decorative unless given a title', () => {
    const plain = svgOf('plex');
    expect(plain!.getAttribute('aria-hidden')).toBe('true');
    const { container } = render(<MediaServerIcon kind="plex" title="Plex" />);
    const labelled = container.querySelector('svg');
    expect(labelled!.getAttribute('aria-hidden')).toBeNull();
    expect(labelled!.querySelector('title')?.textContent).toBe('Plex');
  });

  it('narrows unknown strings', () => {
    expect(isMediaServerKind('plex')).toBe(true);
    expect(isMediaServerKind(null)).toBe(false);
    expect(isMediaServerKind('PLEX')).toBe(false);
  });
});
