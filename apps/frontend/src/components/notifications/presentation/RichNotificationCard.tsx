import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { splitSummary, type NotificationPresentation } from '@ultratorrent/shared';
import { cn } from '@/lib/utils';
import { ACCENT_TOKENS, PRESENTATION_ICONS, relativeTime } from './presentation-tokens';
import { PresentationArtwork } from './PresentationArtwork';

/**
 * The initials avatar.
 *
 * Drawn rather than fetched: no avatar field exists in the schema, and the hue
 * is derived server-side so one person keeps one colour on every card. Marked
 * `aria-hidden` because the name it abbreviates is already in the summary and in
 * the User fact — a screen reader announcing "D" adds nothing but noise.
 */
function Avatar({ initials, hue, ring }: { initials: string; hue: number; ring: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold ring-2',
        ring,
      )}
      style={{
        backgroundColor: `hsl(${hue} 45% 22%)`,
        color: `hsl(${hue} 85% 78%)`,
      }}
    >
      {initials}
    </div>
  );
}

/**
 * The full rich notification card — the in-app projection of a
 * `NotificationPresentation`.
 *
 * It renders only what the presentation contains. There is no fallback that
 * reaches into a raw payload for a field the builder chose to withhold: absence
 * here means the server decided this recipient may not see it, and a component
 * that "helpfully" filled the gap would undo the redaction.
 *
 * Layout follows the concept: state header, two-tone headline and summary beside
 * a poster, a fact table, optional progress, and a single primary action.
 */
export function RichNotificationCard({
  presentation,
  compact = false,
  className,
}: {
  presentation: NotificationPresentation;
  /** Bell-dropdown density: no fact table, no action, smaller poster. */
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
          <PresentationArtwork artwork={presentation.artwork} className="h-12 w-8 shrink-0" />
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
          <span
            className={cn('flex h-6 w-6 items-center justify-center rounded-full', accent.text)}
            aria-hidden="true"
          >
            <StateIcon className="h-3.5 w-3.5" />
          </span>
          <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground">
            {presentation.eyebrow}
          </span>
          <time
            className="ml-auto text-xs text-muted-foreground"
            dateTime={presentation.timestamp}
          >
            {relativeTime(presentation.timestamp, i18n.language)}
          </time>
        </header>

        <div className="flex gap-4">
          {presentation.avatar && (
            <Avatar
              initials={presentation.avatar.initials}
              hue={presentation.avatar.hue}
              ring={accent.ring}
            />
          )}

          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h3 className="text-xl font-semibold leading-tight">
                <span className={accent.text}>{presentation.headline.lead}</span>{' '}
                <span>{presentation.headline.trail}</span>
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {before}
                <span className="font-semibold text-foreground">{emphasis}</span>
                {after}
              </p>
            </div>

            {/* A definition list, not a table: these are label/value pairs, and the
                semantics are what a screen reader needs to pair them up. */}
            {presentation.facts.length > 0 && (
              <dl className="space-y-1.5 text-sm">
                {presentation.facts.map((fact) => {
                  const FactIcon = PRESENTATION_ICONS[fact.icon] ?? PRESENTATION_ICONS.alert;
                  return (
                    <div key={`${fact.label}-${fact.value}`} className="flex items-center gap-2">
                      <FactIcon className={cn('h-3.5 w-3.5 shrink-0', accent.text)} aria-hidden="true" />
                      <dt className="w-20 shrink-0 text-muted-foreground">{fact.label}</dt>
                      {/* Long titles truncate rather than widening the card — an
                          overflowing filename is what broke the duplicates table. */}
                      <dd className="min-w-0 flex-1 truncate" title={fact.value}>{fact.value}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>

          {presentation.artwork && (
            <PresentationArtwork
              artwork={presentation.artwork}
              className="hidden w-24 shrink-0 sm:block"
            />
          )}
        </div>

        {presentation.progress && (
          <div
            role="progressbar"
            aria-valuenow={presentation.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={presentation.progress.label}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={cn('h-full rounded-full transition-[width]', accent.bar)}
              style={{ width: `${presentation.progress.percent}%` }}
            />
          </div>
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
