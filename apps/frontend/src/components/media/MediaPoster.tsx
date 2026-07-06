import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { api, type MediaArtworkRef } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Renders a piece of media artwork, transparently handling both storage modes:
 *   - remote (provider) artwork keeps its CDN `url` → used directly as the src;
 *   - locally-stored artwork (custom uploads, on-disk provider imports) has only
 *     a filesystem `localPath`, unreachable from an <img>, so we fetch the bytes
 *     through the bearer-authenticated image endpoint and hand back an object URL.
 * Falls back to a placeholder icon while loading or when there's no artwork.
 */
export function MediaPoster({
  artwork,
  alt,
  className,
  iconClassName,
  size = 'thumb',
  fit = 'cover',
}: {
  artwork?: MediaArtworkRef | null;
  alt: string;
  className?: string;
  iconClassName?: string;
  /** 'thumb' (default) serves a small cached thumbnail — fast for grids;
   *  'full' serves the original, for large detail views. */
  size?: 'thumb' | 'full';
  /** 'cover' (default) fills the frame; 'contain' shows the whole image without
   *  cropping — right for wide banners/fanart and transparent logos/clearart. */
  fit?: 'cover' | 'contain';
}) {
  const remote = artwork?.url ?? null;
  // Only fetch a blob when there's a local image and no directly-usable url.
  const localId = !remote && artwork?.localPath ? artwork.id : null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!localId) {
      setBlobUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | undefined;
    api.media
      .artworkImage(localId, size === 'thumb')
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (active) setBlobUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localId, size]);

  const src = remote ?? blobUrl;

  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden bg-white/[0.03]',
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          className={cn('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover')}
          loading="lazy"
        />
      ) : (
        <Film className={cn('h-5 w-5 text-muted-foreground', iconClassName)} />
      )}
    </div>
  );
}
