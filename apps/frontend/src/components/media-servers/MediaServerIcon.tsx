/**
 * Brand marks for the media servers UltraTorrent connects to.
 *
 * Drawn inline rather than shipped as image files: they render at any size, need
 * no network fetch under the CSP, and inherit nothing from the theme — a brand
 * colour that flipped with light/dark would stop being a brand colour.
 *
 * These are simplified, recognisable marks in each product's own palette, not
 * exact reproductions of the trademarks. Identification is the whole job here:
 * with Plex and Jellyfin side by side, the point is to tell them apart at a
 * glance.
 */

export type MediaServerKind = 'plex' | 'jellyfin' | 'emby' | 'kodi';

/** The colour each product is recognised by. */
export const MEDIA_SERVER_COLOR: Record<MediaServerKind, string> = {
  plex: '#E5A00D',
  jellyfin: '#AA5CC3',
  emby: '#52B54B',
  kodi: '#17B2E7',
};

const TITLE: Record<MediaServerKind, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
  kodi: 'Kodi',
};

export function isMediaServerKind(v: string | null | undefined): v is MediaServerKind {
  return v === 'plex' || v === 'jellyfin' || v === 'emby' || v === 'kodi';
}

export function MediaServerIcon({
  kind,
  className = 'h-4 w-4',
  title,
}: {
  kind: string | null | undefined;
  className?: string;
  /** Omit for a decorative icon sitting beside the server's name. */
  title?: string;
}) {
  if (!isMediaServerKind(kind)) return null;
  const label = title ?? TITLE[kind];
  const common = {
    className,
    viewBox: '0 0 24 24',
    xmlns: 'http://www.w3.org/2000/svg',
    role: title ? ('img' as const) : ('presentation' as const),
    'aria-hidden': title ? undefined : true,
  };

  if (kind === 'plex') {
    // Amber tile with the chevron Plex is known by.
    return (
      <svg {...common}>
        {title && <title>{label}</title>}
        <rect x="2" y="2" width="20" height="20" rx="4" fill={MEDIA_SERVER_COLOR.plex} />
        <path d="M9 6.5h3.4l4.1 5.5-4.1 5.5H9l4.1-5.5L9 6.5Z" fill="#1F1B14" />
      </svg>
    );
  }

  if (kind === 'jellyfin') {
    // Jellyfin's purple-to-blue gradient on its stacked chevron silhouette.
    const gid = 'ut-jellyfin-grad';
    return (
      <svg {...common}>
        {title && <title>{label}</title>}
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#AA5CC3" />
            <stop offset="100%" stopColor="#00A4DC" />
          </linearGradient>
        </defs>
        <path d="M12 3.2c-1 0-5.6 8.1-5.1 9.1.5 1 9.7 1 10.2 0 .5-1-4.1-9.1-5.1-9.1Z" fill={`url(#${gid})`} />
        <path d="M12 13.4c-.7 0-4 5.8-3.7 6.5.4.7 7 .7 7.4 0 .4-.7-3-6.5-3.7-6.5Z" fill={`url(#${gid})`} opacity="0.75" />
      </svg>
    );
  }

  if (kind === 'emby') {
    // Emby's green, with the notched arc of its mark.
    return (
      <svg {...common}>
        {title && <title>{label}</title>}
        <path
          d="M12 2.6 21.4 12 12 21.4 2.6 12 12 2.6Zm0 4.6L7.2 12 12 16.8 16.8 12 12 7.2Z"
          fill={MEDIA_SERVER_COLOR.emby}
        />
      </svg>
    );
  }

  // Kodi: its blue, on the angular play-box the logo is built from.
  return (
    <svg {...common}>
      {title && <title>{label}</title>}
      <circle cx="12" cy="12" r="9.4" fill={MEDIA_SERVER_COLOR.kodi} />
      <path d="M9.4 6.6 15.8 12l-6.4 5.4V6.6Z" fill="#08222B" />
    </svg>
  );
}
