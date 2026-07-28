import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface AlphabetEntry {
  letter: string;
  count: number;
}

/**
 * The A–Z jump rail, down the right edge of a library.
 *
 * Clicking a letter **anchors** the listing there rather than filtering to it:
 * landing on M keeps N, O, P below, so scrolling continues naturally. Filtering
 * would strand the reader inside one letter, which is not what an index is for.
 *
 * Empty letters are shown disabled rather than removed. A rail that dropped its
 * gaps would change length and reflow as a library grew, and the reader would
 * be left wondering where a letter went instead of being told there is nothing
 * under it.
 */
export function AlphabetRail({
  entries,
  active,
  onJump,
  className,
}: {
  entries: AlphabetEntry[];
  /** The anchored letter, or null when showing the list from the top. */
  active: string | null;
  onJump: (letter: string | null) => void;
  className?: string;
}) {
  const { t } = useTranslation('media');

  if (!entries.length) return null;

  return (
    <nav
      aria-label={t('browser.alphabet.label')}
      className={cn(
        'flex shrink-0 select-none flex-col items-center gap-px overflow-hidden py-1',
        className,
      )}
    >
      {/*
        "All" is what makes the rail reversible. Anchoring is one-way — you
        cannot scroll above the anchor — so without a way back the reader is
        stuck at whatever letter they last pressed.
      */}
      <button
        type="button"
        onClick={() => onJump(null)}
        aria-current={active === null ? 'true' : undefined}
        className={cn(
          'w-6 rounded text-[10px] font-semibold leading-5 transition-colors',
          active === null
            ? 'bg-primary/20 text-primary'
            : 'text-muted-foreground hover:bg-white/10 hover:text-foreground',
        )}
      >
        {t('browser.alphabet.all')}
      </button>

      {entries.map(({ letter, count }) => {
        const empty = count === 0;
        return (
          <button
            key={letter}
            type="button"
            disabled={empty}
            onClick={() => onJump(letter)}
            aria-current={active === letter ? 'true' : undefined}
            /* The count reaches a screen reader, which cannot see "greyed out". */
            aria-label={t('browser.alphabet.jump', { letter, count })}
            title={empty ? undefined : t('browser.alphabet.jump', { letter, count })}
            className={cn(
              'w-6 rounded text-[11px] font-medium leading-[1.15rem] transition-colors',
              empty && 'cursor-default text-muted-foreground/25',
              !empty && active === letter && 'bg-primary/20 text-primary',
              !empty && active !== letter && 'text-muted-foreground hover:bg-white/10 hover:text-foreground',
            )}
          >
            {letter}
          </button>
        );
      })}
    </nav>
  );
}
