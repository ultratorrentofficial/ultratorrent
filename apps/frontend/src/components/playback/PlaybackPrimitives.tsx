import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import type {
  PresentationAccent,
  PresentationArtwork,
  PresentationAvatar,
  PresentationFact,
  PresentationProgress,
} from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ACCENT_TOKENS, PRESENTATION_ICONS } from './playback-tokens';

/**
 * The shared playback primitives.
 *
 * Both the rich notification card and the Live Activity dashboard render these,
 * so a session card and a playback notification cannot drift apart — there is
 * one implementation of "what an episode looks like", not two.
 */

/* ------------------------------------------------------------------ artwork */

/**
 * Renders an artwork *reference* by resolving it through the route its `kind`
 * names.
 *
 * The presentation never carries an image URL: a link that worked without a
 * token would be permanent unauthenticated access to library artwork. So the
 * image is bearer-fetched as a blob — an `<img src>` cannot carry an
 * Authorization header.
 *
 * Every failure path lands on the same placeholder. Missing artwork must degrade
 * the card, never blank it.
 */
export function PlaybackArtwork({
  artwork,
  className,
}: {
  artwork: PresentationArtwork;
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
      // Revoked on unmount as well as on change: a list scrolls through many of
      // these, and leaked object URLs live as long as the document.
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
        // being shown, and announcing it promises something the fallback does
        // not deliver.
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

/* ------------------------------------------------------------------- avatar */

/**
 * The initials avatar.
 *
 * Drawn, not fetched: no avatar field exists in the schema, and the hue is
 * derived server-side so one person keeps one colour on every surface.
 * `aria-hidden` because the name it abbreviates is already in the summary and in
 * the User fact — announcing "D" adds noise, not information.
 */
export function PlaybackAvatar({
  avatar,
  accent,
  size = 'md',
}: {
  avatar: PresentationAvatar;
  accent: PresentationAccent;
  size?: 'sm' | 'md';
}) {
  const ring = ACCENT_TOKENS[accent]?.ring ?? ACCENT_TOKENS.neutral.ring;
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold ring-2',
        size === 'sm' ? 'h-8 w-8 text-xs' : 'h-12 w-12 text-base',
        ring,
      )}
      style={{
        backgroundColor: `hsl(${avatar.hue} 45% 22%)`,
        color: `hsl(${avatar.hue} 85% 78%)`,
      }}
    >
      {avatar.initials}
    </div>
  );
}

/* -------------------------------------------------------------- state badge */

export function PlaybackStateBadge({
  label,
  accent,
  icon,
}: {
  label: string;
  accent: PresentationAccent;
  icon: keyof typeof PRESENTATION_ICONS;
}) {
  const tokens = ACCENT_TOKENS[accent] ?? ACCENT_TOKENS.neutral;
  const Icon = PRESENTATION_ICONS[icon] ?? PRESENTATION_ICONS.alert;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        tokens.border, tokens.text,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------- progress */

export function PlaybackProgress({
  progress,
  accent,
}: {
  progress: PresentationProgress;
  accent: PresentationAccent;
}) {
  const tokens = ACCENT_TOKENS[accent] ?? ACCENT_TOKENS.neutral;
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={progress.label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={cn('h-full rounded-full transition-[width]', tokens.bar)}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {progress.positionLabel && (
        <p className="text-[11px] text-muted-foreground">{progress.positionLabel}</p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- facts */

/**
 * A definition list, not a table: these are label/value pairs, and the semantics
 * are what a screen reader needs to pair them up.
 */
export function PlaybackFacts({
  facts,
  accent,
}: {
  facts: PresentationFact[];
  accent: PresentationAccent;
}) {
  const tokens = ACCENT_TOKENS[accent] ?? ACCENT_TOKENS.neutral;
  if (!facts.length) return null;
  return (
    <dl className="space-y-1.5 text-sm">
      {facts.map((fact, i) => {
        const Icon = PRESENTATION_ICONS[fact.icon] ?? PRESENTATION_ICONS.alert;
        return (
          <div key={`${fact.label}-${i}`} className="flex items-center gap-2">
            <Icon className={cn('h-3.5 w-3.5 shrink-0', tokens.text)} aria-hidden="true" />
            <dt className="w-20 shrink-0 text-muted-foreground">{fact.label}</dt>
            {/* Long titles truncate rather than widening the card. */}
            <dd className="min-w-0 flex-1 truncate" title={fact.value}>
              {fact.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/* ------------------------------------------------------------------- title */

export function PlaybackTitle({
  lead,
  trail,
  accent,
}: {
  lead: string;
  trail: string;
  accent: PresentationAccent;
}) {
  const tokens = ACCENT_TOKENS[accent] ?? ACCENT_TOKENS.neutral;
  return (
    <h3 className="text-xl font-semibold leading-tight">
      <span className={tokens.text}>{lead}</span> <span>{trail}</span>
    </h3>
  );
}
