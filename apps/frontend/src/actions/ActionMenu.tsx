/**
 * The compact action surface — for table rows and detail headers.
 *
 * Same resolution as `ActionBar`, different shape. A toolbar is wrong in a table
 * row: it competes with the row's data for width, and twenty of them stacked
 * down a page is not a list any more. This renders either an icon cluster or a
 * single kebab, and takes exactly the `groups` / `handlers` contract the bar
 * does — so a surface can switch between them without changing anything else,
 * and neither shape can offer an action the other would not.
 *
 * Why this exists at all: without it the migration would take the easy toolbars
 * and leave every row cluster on its own private resolver, which is most of the
 * remaining surfaces and precisely the ones that gate least well today.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import type { ActionGroup, ActionVerdict, EntityRef, UnavailableReason } from '@ultratorrent/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { actionIcon } from './action-icons';
import type { ActionHandler } from './ActionBar';

export interface ActionMenuProps {
  groups: Array<{ group: ActionGroup; actions: ActionVerdict[] }>;
  /** Usually one entity — a row — but the contract is the same for many. */
  selection: readonly EntityRef[];
  handlers: Record<string, ActionHandler>;
  /**
   * `icons` puts every action inline as an icon button; `kebab` hides them
   * behind one control. Use `icons` when there are few and they are used
   * constantly, `kebab` when there are many or they are occasional.
   */
  variant?: 'icons' | 'kebab';
  busy?: boolean;
  className?: string;
}

/** Runtime-built keys; see the note on `DynamicT` in ActionBar. */
type DynamicT = (key: string, opts?: Record<string, unknown>) => string;

function reasonKey(reason?: UnavailableReason): string {
  return reason === 'max_selection' ? 'reason.maxSelection' : 'reason.entityCapability';
}

export function ActionMenu({
  groups,
  selection,
  handlers,
  variant = 'icons',
  busy = false,
  className,
}: ActionMenuProps) {
  const { t } = useTranslation('actions');
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  /*
   * Flattened, because a row has no space for group headings — but flattened in
   * group order, so the sequence a user sees here matches the bar. Actions
   * without a handler are dropped for the same reason as in the bar: a control
   * that does nothing reads as a broken feature.
   */
  const actions = useMemo(
    () => groups.flatMap((g) => g.actions).filter((v) => handlers[v.action.id]),
    [groups, handlers],
  );

  // Close the kebab on an outside click or Escape, like every other menu here.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A row with nothing to offer renders nothing — not an empty menu button,
  // which would invite a click that opens onto emptiness.
  if (!actions.length) return null;

  const run = (id: string) => {
    handlers[id]?.(selection);
    setOpen(false);
  };

  if (variant === 'icons') {
    return (
      <div className={cn('flex items-center gap-0.5', className)}>
        {actions.map((v) => {
          const Icon = actionIcon(v.action.icon);
          const label = (t as DynamicT)(`action.${v.action.id}`);
          const reason = v.enabled ? undefined : (t as DynamicT)(reasonKey(v.reason));
          const button = (
            <Button
              key={v.action.id}
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              disabled={busy || !v.enabled}
              /*
               * The icon carries no text, so the label must reach a screen
               * reader some other way — and when the action is blocked the
               * REASON has to reach it too. A `title` alone does not: a
               * disabled button is `pointer-events-none`, so the browser never
               * fires the hover that would show it.
               */
              aria-label={reason ? `${label} — ${reason}` : label}
              title={reason ?? label}
              onClick={(e) => {
                // Rows are usually clickable themselves; acting must not also
                // open the drawer behind the button.
                e.stopPropagation();
                run(v.action.id);
              }}
            >
              {Icon ? (
                <Icon className={cn('h-4 w-4', v.action.destructive && 'text-red-400')} aria-hidden />
              ) : (
                <span className="text-xs">{label.slice(0, 1)}</span>
              )}
            </Button>
          );

          // The wrapper is what makes the tooltip reachable: it is not
          // disabled, so it still receives hover and carries the title.
          return reason ? (
            <span key={v.action.id} title={reason} className="inline-flex cursor-not-allowed">
              {button}
            </span>
          ) : (
            button
          );
        })}
      </div>
    );
  }

  return (
    <div ref={wrapper} className={cn('relative', className)}>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('menu.label')}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label={t('menu.label')}
          className="absolute right-0 z-50 mt-1 min-w-48 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl backdrop-blur"
        >
          {actions.map((v) => {
            const Icon = actionIcon(v.action.icon);
            const label = (t as DynamicT)(`action.${v.action.id}`);
            const reason = v.enabled ? undefined : (t as DynamicT)(reasonKey(v.reason));
            return (
              <button
                key={v.action.id}
                type="button"
                role="menuitem"
                disabled={v.enabled === false}
                // A menu item has visible text, so the reason goes on the
                // accessible name rather than relying on a hover a disabled
                // control never receives.
                aria-label={reason ? `${label} — ${reason}` : undefined}
                title={reason}
                onClick={(e) => {
                  e.stopPropagation();
                  run(v.action.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                  v.enabled
                    ? 'hover:bg-white/10'
                    : 'cursor-not-allowed text-muted-foreground opacity-60',
                  v.action.destructive && v.enabled && 'text-red-300 hover:bg-red-500/10',
                )}
              >
                {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
