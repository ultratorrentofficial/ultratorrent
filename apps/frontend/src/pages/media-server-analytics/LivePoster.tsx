import { useEffect, useState } from 'react';
import { Film, Music, Tv, MonitorPlay } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { mediaTypeColor } from './analytics-colors';

function iconFor(mediaType: string | null) {
  switch ((mediaType ?? '').toLowerCase()) {
    case 'movie': return Film;
    case 'episode': case 'show': case 'season': return Tv;
    case 'track': case 'music': case 'audio': return Music;
    default: return MonitorPlay;
  }
}

/**
 * Now-playing poster for a live session. The image is proxied through the
 * backend (provider auth injected there), so we bearer-fetch it as a blob —
 * an <img src> can't carry the token. Falls back to a media-type-tinted
 * gradient + icon while loading, on error, or when the session has no art.
 */
export function LivePoster({
  sessionId,
  hasArt,
  mediaType,
  alt,
  className,
}: {
  sessionId: string;
  hasArt: boolean;
  mediaType: string | null;
  alt: string;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const Icon = iconFor(mediaType);
  const tint = mediaTypeColor(mediaType);

  useEffect(() => {
    if (!hasArt) return;
    let active = true;
    let objectUrl: string | undefined;
    setFailed(false);
    api.mediaServerAnalytics
      .liveArtwork(sessionId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, hasArt]);

  const showImage = hasArt && blobUrl && !failed;

  return (
    <div className={cn('relative overflow-hidden bg-white/[0.03]', className)}>
      {showImage ? (
        <img src={blobUrl} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{ background: `linear-gradient(150deg, ${tint}33, ${tint}0d 60%, transparent)` }}
        >
          <Icon className="h-8 w-8 opacity-40" style={{ color: tint }} />
        </div>
      )}
    </div>
  );
}
