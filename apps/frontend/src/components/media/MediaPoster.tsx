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
}: {
  artwork?: MediaArtworkRef | null;
  alt: string;
  className?: string;
  iconClassName?: string;
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
      .artworkImage(localId)
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
  }, [localId]);

  const src = remote ?? blobUrl;

  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden bg-white/[0.03]',
        className,
      )}
    >
      {src ? (
        <img src={src} alt={alt} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Film className={cn('h-5 w-5 text-muted-foreground', iconClassName)} />
      )}
    </div>
  );
}
