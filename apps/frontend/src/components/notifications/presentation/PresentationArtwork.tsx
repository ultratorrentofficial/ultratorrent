import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import type { PresentationArtwork as ArtworkRef } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Renders an artwork *reference* by resolving it through the route its `kind`
 * names.
 *
 * The presentation never carries an image URL — a link that worked without a
 * token would be permanent unauthenticated access to library artwork. So the
 * image is bearer-fetched as a blob, exactly as `LivePoster` already does for
 * live sessions; an `<img src>` cannot carry an Authorization header.
 *
 * Every failure path lands on the same tinted placeholder: a missing poster must
 * degrade the card, never blank it.
 */
export function PresentationArtwork({
  artwork,
  className,
}: {
  artwork: ArtworkRef;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setFailed(false);
    setBlobUrl(null);

    const fetcher =
      artwork.kind === 'notification'
        ? api.mediaServerAnalytics.notificationArtwork(artwork.id)
        : api.mediaServerAnalytics.liveArtwork(artwork.id);

    fetcher
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => active && setFailed(true));

    return () => {
      active = false;
      // Revoked on unmount as well as on change — a notification list scrolls
      // through many of these, and leaked object URLs are retained for the life
      // of the document.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artwork.kind, artwork.id]);

  const shape = artwork.aspect === 'poster' ? 'aspect-[2/3]' : 'aspect-video';

  if (!blobUrl || failed) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-white/5 bg-gradient-to-br from-white/[0.06] to-transparent',
          shape, className,
        )}
        // Decorative in this state: the alt text describes an image that is not
        // being shown, and announcing it would promise the reader something the
        // fallback does not deliver.
        aria-hidden="true"
      >
        <Film className="h-5 w-5 text-muted-foreground/50" />
      </div>
    );
  }

  return (
    <img
      src={blobUrl}
      alt={artwork.alt}
      loading="lazy"
      className={cn('rounded-lg border border-white/5 object-cover', shape, className)}
    />
  );
}
