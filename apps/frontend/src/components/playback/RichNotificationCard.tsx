import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { splitSummary, type NotificationPresentation } from '@ultratorrent/shared';
import { cn } from '@/lib/utils';
import { ACCENT_TOKENS, PRESENTATION_ICONS, relativeTime } from './playback-tokens';
import {
  PlaybackArtwork, PlaybackAvatar, PlaybackFacts, PlaybackProgress, PlaybackTitle,
} from './PlaybackPrimitives';

/**
 * The in-app projection of a `NotificationPresentation`.
 *
 * It renders only what the presentation contains. There is no fallback that
 * reaches into a raw payload for a field the builder withheld — absence here
 * means the server decided this recipient may not see it, and a component that
 * "helpfully" filled the gap would undo the redaction.
 */
export function RichNotificationCard({
  presentation,
  compact = false,
  className,
}: {
  presentation: NotificationPresentation;
  /** Bell-preview density: no fact table, no action, smaller poster. */
  compact?: boolean;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const accent = ACCENT_TOKENS[presentation.accent] ?? ACCENT_TOKENS.neutral;
  const StateIcon = PRESENTATION_ICONS[presentation.icon] ?? PRESENTATION_ICONS.alert;
  const [before, emphasis, after] = splitSummary(presentation.summary);
  const ActionIcon = presentation.action?.icon
    ? PRESENTATION_ICONS[presentation.action.icon]
    : null;

  if (compact) {
    return (
      <div className={cn('flex items-start gap-3', className)}>
        <StateIcon className={cn('mt-0.5 h-4 w-4 shrink-0', accent.text)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            {before}
            <span className="font-semibold">{emphasis}</span>
            {after}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {relativeTime(presentation.timestamp, i18n.language)}
            {presentation.status ? ` · ${presentation.status}` : ''}
          </p>
        </div>
        {presentation.artwork && (
          <PlaybackArtwork artwork={presentation.artwork} className="h-12 w-8 shrink-0" />
        )}
      </div>
    );
  }

  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-xl border bg-card/60 backdrop-blur',
        accent.border, className,
      )}
    >
      {/* Ambient wash + leading rail: the accent as atmosphere, not another label. */}
      <div
        className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent', accent.glow)}
        aria-hidden="true"
      />
      <div className={cn('absolute inset-y-0 left-0 w-[3px]', accent.rail)} aria-hidden="true" />

      <div className="relative space-y-4 p-4 pl-5">
        <header className="flex items-center gap-2">
          <span className={cn('flex h-6 w-6 items-center justify-center rounded-full', accent.text)} aria-hidden="true">
            <StateIcon className="h-3.5 w-3.5" />
          </span>
          <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground">
            ULTRATORRENT
          </span>
          <time className="ml-auto text-xs text-muted-foreground" dateTime={presentation.timestamp}>
            {relativeTime(presentation.timestamp, i18n.language)}
          </time>
        </header>

        <div className="flex gap-4">
          {presentation.avatar && (
            <PlaybackAvatar avatar={presentation.avatar} accent={presentation.accent} />
          )}

          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <PlaybackTitle
                lead={presentation.headline.lead}
                trail={presentation.headline.trail}
                accent={presentation.accent}
              />
              <p className="mt-1 text-sm text-muted-foreground">
                {before}
                <span className="font-semibold text-foreground">{emphasis}</span>
                {after}
              </p>
            </div>
            <PlaybackFacts facts={presentation.facts} accent={presentation.accent} />
          </div>

          {presentation.artwork && (
            <PlaybackArtwork
              artwork={presentation.artwork}
              className="hidden w-24 shrink-0 sm:block"
            />
          )}
        </div>

        {presentation.progress && (
          <PlaybackProgress progress={presentation.progress} accent={presentation.accent} />
        )}

        {presentation.action && (
          <Link
            to={presentation.action.href}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg border border-white/10',
              'px-4 py-2.5 text-sm font-medium tracking-wide transition-colors',
              accent.button,
            )}
          >
            {ActionIcon && <ActionIcon className="h-4 w-4" aria-hidden="true" />}
            {presentation.action.label}
          </Link>
        )}
      </div>
    </article>
  );
}
