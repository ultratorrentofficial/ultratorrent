import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { type ActivityItem } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const ACTIVITY_TONE: Record<NonNullable<ActivityItem['level']>, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

export function ActivityRow({
  item,
  expanded = false,
  onToggle,
}: {
  item: ActivityItem;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const events = item.events ?? [];
  const expandable = events.length > 0 && Boolean(onToggle);

  const body = (
    <>
      <span
        className={cn(
          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current',
          ACTIVITY_TONE[item.level ?? 'info'],
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground/90">{item.message}</span>
        {item.detail && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.detail}
          </span>
        )}
      </span>
      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatRelativeTime(item.at)}
      </span>
    </>
  );

  if (!expandable) {
    return <li className="flex items-start gap-3 py-2.5">{body}</li>;
  }

  return (
    <li className="py-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={
          expanded ? t('activity.collapse') : t('activity.expand', { count: events.length })
        }
        className="flex w-full items-start gap-3 rounded-md py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
        <ChevronDown
          aria-hidden
          className={cn(
            'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && (
        <ul className="mb-1 ml-4 border-l border-border/60 pl-4">
          {events.map((event) => (
            <ActivityRow key={event.id} item={event} />
          ))}
        </ul>
      )}
    </li>
  );
}
