import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, History } from 'lucide-react';
import { api, type NewsletterActivityEntry, type NewsletterActivityEvent } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

const TONE: Record<NewsletterActivityEvent['level'], string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

/**
 * Newsletter activity: what happened during generation and distribution.
 *
 * Every entry is one RUN. A send writes an event per recipient, so a flat feed
 * would be two hundred near-identical lines; the run's outcome leads and the
 * rest — the generation, each recipient, each refusal — open beneath it.
 *
 * The grouping is done on the server, so this renders what it is given rather
 * than re-deriving which event should lead. One rule, one place.
 */
export function NewsletterActivityCard({ newsletterId }: { newsletterId?: string }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['newsletter-activity', newsletterId ?? 'all'],
    queryFn: () => api.mediaServerAnalytics.newsletterActivity({ newsletterId, limit: 50 }),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-semibold">{t('newsletterActivity.title')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t('newsletterActivity.description')}</p>

        {q.isLoading ? (
          <CenteredSpinner label={t('newsletterActivity.loading')} />
        ) : q.isError ? (
          <ErrorState message={t('newsletterActivity.error')} onRetry={() => q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState
            title={t('newsletterActivity.emptyTitle')}
            description={t('newsletterActivity.emptyDescription')}
          />
        ) : (
          <ul className="space-y-1">
            {(q.data ?? []).map((entry) => (
              <ActivityEntry
                key={entry.id}
                entry={entry}
                expanded={openId === entry.id}
                onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: NewsletterActivityEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('mediaServerAnalytics');
  // Expandable when there is more to see: the events of the run, or the detail
  // carried by a standalone event such as a scheduled dispatch that failed.
  const detail = describeMetadata(entry.metadata);
  const expandable = entry.events.length > 0 || detail.length > 0 || Boolean(entry.sanitizedMessage);

  return (
    <li className="rounded border border-border/50">
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(
          'flex w-full items-start gap-2 px-2 py-1.5 text-left',
          expandable && 'hover:bg-muted/40',
        )}
      >
        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current', TONE[entry.level])} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{describe(entry, t as unknown as LooseT)}</span>
          <span className="block text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
        </span>
        {expandable && (
          <ChevronDown
            className={cn('mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
            aria-hidden
          />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border/50 px-3 py-2">
          {entry.sanitizedMessage && (
            <p className="text-xs text-destructive break-words">{entry.sanitizedMessage}</p>
          )}
          {detail.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {detail.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{t(`newsletterActivity.field.${key}`, { defaultValue: key })}</dt>
                  <dd className="break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {entry.events.length > 0 && (
            <ul className="space-y-0.5 border-t border-border/40 pt-2">
              {entry.events.map((event) => (
                <li key={event.id} className="flex items-start gap-2 text-xs">
                  <span className={cn('mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current', TONE[event.level])} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">{describe(event, t as unknown as LooseT)}</span>
                    {event.sanitizedMessage && (
                      <span className="block break-words text-destructive">{event.sanitizedMessage}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A sentence for one event.
 *
 * The server sends a message KEY and its parameters rather than a sentence, so
 * the record is not frozen into the language it happened to be written in. The
 * event type is the fallback: an entry from a newer server than this UI still
 * says something rather than rendering blank.
 */
/**
 * `t` is deliberately loosened here.
 *
 * The key is built from server data — an event type, or the tail of a message
 * key — so it cannot belong to the compile-time union of known keys. Every call
 * carries a defaultValue, so an event from a newer server than this UI renders
 * as something readable rather than as a blank line.
 */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

function describe(event: NewsletterActivityEvent, t: LooseT): string {
  if (event.messageKey) {
    return t(`newsletterActivity.message.${event.messageKey.split('.').pop()}`, {
      ...(event.messageParams ?? {}),
      defaultValue: event.sanitizedMessage ?? event.eventType,
    });
  }
  return t(`newsletterActivity.event.${event.eventType}`, {
    defaultValue: event.sanitizedMessage ?? event.eventType,
  });
}

/** Metadata as displayable pairs, skipping what the line already says. */
function describeMetadata(metadata: Record<string, unknown> | null): Array<[string, string]> {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]);
}
