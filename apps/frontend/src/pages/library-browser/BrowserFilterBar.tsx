import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Match states the server filters on. */
export const MATCH_STATUSES = ['unmatched', 'matched', 'manual'] as const;
export type MatchStatusFilter = (typeof MATCH_STATUSES)[number];

export interface BrowserFilters {
  search: string;
  matchStatus: MatchStatusFilter | null;
}

export const EMPTY_FILTERS: BrowserFilters = { search: '', matchStatus: null };

/** Long enough that a typist does not fire a query per keystroke, short enough to feel instant. */
export const SEARCH_DEBOUNCE_MS = 250;

export function hasActiveFilters(f: BrowserFilters): boolean {
  return f.search.trim() !== '' || f.matchStatus !== null;
}

/**
 * Search and filtering, over what the server can actually answer.
 *
 * `GET /media/items` filters on `search` (a case-insensitive title contains),
 * `matchStatus` and `mediaType`. It does **not** filter on resolution, HDR,
 * codec, genre, year, studio or runtime — those columns exist on `MediaFile`
 * and `MediaMetadata` but are not query parameters, so offering them here would
 * be a control that silently does nothing.
 *
 * Filtering happens **server-side**, not over the loaded page. The browser holds
 * one screenful of an incrementally paged library; filtering that would search
 * the 60 rows fetched so far and confidently report no matches for a title
 * sitting later in the library.
 */
export function BrowserFilterBar({
  value, onChange,
}: {
  value: BrowserFilters;
  onChange: (next: BrowserFilters) => void;
}) {
  const { t } = useTranslation('media');
  const [text, setText] = useState(value.search);

  // Debounced: each change is a network round trip and a full list reset.
  useEffect(() => {
    if (text === value.search) return;
    const timer = setTimeout(() => onChange({ ...value, search: text }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  // Keep the box in step when the filters are cleared from elsewhere.
  useEffect(() => setText(value.search), [value.search]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={text}
          aria-label={t('browser.searchLabel')}
          placeholder={t('browser.searchPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          className="pl-8"
        />
      </div>

      <div className="flex items-center gap-1" role="group" aria-label={t('browser.matchStatus')}>
        {MATCH_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={value.matchStatus === status}
            onClick={() =>
              onChange({ ...value, matchStatus: value.matchStatus === status ? null : status })
            }
            className={cn(
              'rounded-md border border-white/10 px-2 py-1 text-xs transition-colors',
              value.matchStatus === status
                ? 'border-white/30 bg-white/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`browser.status.${status}`)}
          </button>
        ))}
      </div>

      {hasActiveFilters(value) && (
        <Button size="sm" variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t('browser.clearFilters')}
        </Button>
      )}
    </div>
  );
}
