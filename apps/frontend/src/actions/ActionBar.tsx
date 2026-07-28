/**
 * The one action surface.
 *
 * Every workspace renders this rather than its own toolbar: the actions come
 * from the CAMA registry, grouped and ordered platform-wide, so a user who
 * learns where artwork work lives in one place finds it in the same place
 * everywhere. A surface supplies only the *handlers* — what its ids actually do.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, X, type LucideIcon } from 'lucide-react';
import type { ActionGroup, ActionVerdict, EntityRef, UnavailableReason } from '@ultratorrent/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { actionIcon } from './action-icons';

/** What a surface does when one of its actions is chosen. */
export type ActionHandler = (selection: readonly EntityRef[]) => void | Promise<void>;

export interface ActionBarProps {
  groups: Array<{ group: ActionGroup; actions: ActionVerdict[] }>;
  selection: readonly EntityRef[];
  /** Keyed by action id. An action with no handler here is never rendered. */
  handlers: Record<string, ActionHandler>;
  onClear?: () => void;
  busy?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  /**
   * Groups shown inline rather than behind a disclosure. The rest collapse, so
   * a selection offering twenty actions does not present twenty buttons.
   */
  primaryGroups?: ActionGroup[];
  className?: string;
}

const DEFAULT_PRIMARY: ActionGroup[] = ['media', 'playback', 'metadata'];

/** How many actions may sit inline in a primary group before it collapses too. */
const INLINE_LIMIT = 4;

/**
 * Look up a key built at runtime.
 *
 * Action and group ids come from the server registry, so their keys cannot be
 * known to the compiler — and asking it to check them against the typed
 * resource union is not merely useless but expensive: the union spans every
 * namespace (~4 100 keys), and resolving a template-literal type against it
 * exhausted `tsc`'s default heap outright. The cast erases that work for keys
 * that were never checkable.
 *
 * The safety this gives up is recovered by the i18n parity gate, which fails
 * when a key exists in one locale and not the other.
 */
type DynamicT = (key: string, opts?: Record<string, unknown>) => string;

export function ActionBar({
  groups,
  selection,
  handlers,
  onClear,
  busy = false,
  isLoading = false,
  isError = false,
  primaryGroups = DEFAULT_PRIMARY,
  className,
}: ActionBarProps) {
  const { t } = useTranslation('actions');
  const [openGroup, setOpenGroup] = useState<ActionGroup | null>(null);

  /*
   * Drop actions this surface cannot perform.
   *
   * The registry is platform-wide, so it will legitimately resolve actions a
   * given surface has not wired up. Rendering one would be a button that does
   * nothing — worse than its absence, because the user would conclude the
   * feature is broken rather than elsewhere.
   */
  const runnable = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, actions: g.actions.filter((v) => handlers[v.action.id]) }))
        .filter((g) => g.actions.length > 0),
    [groups, handlers],
  );

  const count = selection.length;

  if (isError) {
    return (
      <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/90">
        {t('bar.unavailable')}
      </div>
    );
  }

  // Nothing to offer: say so rather than rendering an empty chrome bar.
  if (isLoading || !runnable.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {isLoading ? t('bar.loading') : count ? t('bar.noneForSelection') : t('bar.noSelection')}
        </span>
        <span className="flex-1" />
        {count > 0 && onClear && <ClearButton onClear={onClear} />}
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label={t('bar.label')}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2',
        count ? 'border-white/20 bg-white/[0.06]' : 'border-white/10 bg-white/[0.03]',
        className,
      )}
    >
      <span className="text-xs font-medium tabular-nums">
        {count ? t('bar.selected', { count }) : t('bar.library')}
      </span>
      <span className="flex-1" />

      {runnable.map(({ group, actions }) => {
        const inline = primaryGroups.includes(group) && actions.length <= INLINE_LIMIT;
        return inline ? (
          <div key={group} className="flex items-center gap-1.5">
            {actions.map((v) => (
              <ActionButton
                key={v.action.id}
                verdict={v}
                busy={busy}
                onRun={() => handlers[v.action.id]?.(selection)}
              />
            ))}
          </div>
        ) : (
          <GroupMenu
            key={group}
            group={group}
            actions={actions}
            busy={busy}
            open={openGroup === group}
            onOpenChange={(open) => setOpenGroup(open ? group : null)}
            onRun={(id) => {
              handlers[id]?.(selection);
              setOpenGroup(null);
            }}
          />
        );
      })}

      {count > 0 && onClear && <ClearButton onClear={onClear} />}
    </div>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation('actions');
  return (
    <Button size="sm" variant="ghost" onClick={onClear} aria-label={t('bar.clear')}>
      <X className="h-4 w-4" aria-hidden />
    </Button>
  );
}

/**
 * One action.
 *
 * A blocked action reaches here only when its descriptor asked to explain itself
 * rather than vanish; the title carries the reason, because a disabled control
 * with no explanation is worse than an absent one.
 */
function ActionButton({
  verdict,
  busy,
  onRun,
}: {
  verdict: ActionVerdict;
  busy: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation('actions');
  const { action, enabled, reason } = verdict;
  const Icon: LucideIcon | null = actionIcon(action.icon);
  const label = (t as DynamicT)(`action.${action.id}`);

  const why = enabled ? undefined : (t as DynamicT)(reasonKey(reason));

  const button = (
    <Button
      size="sm"
      variant={action.destructive ? 'destructive' : 'ghost'}
      disabled={busy || !enabled}
      // The label is visible, so the REASON is what the accessible name must
      // add. A `title` alone never appears: a disabled button is
      // `pointer-events-none`, so the browser fires no hover to show it.
      aria-label={why ? `${label} — ${why}` : undefined}
      title={why}
      onClick={onRun}
    >
      {Icon && <Icon className="mr-1.5 h-4 w-4" aria-hidden />}
      {label}
    </Button>
  );

  /*
   * A blocked action is wrapped so the explanation is reachable at all. The
   * wrapper is not disabled, so it still receives hover and carries the title —
   * without it, choosing `whenUnavailable: 'disable'` produced a dead control
   * that said nothing, which is worse than hiding the action outright.
   */
  return why ? (
    <span title={why} className="inline-flex cursor-not-allowed">
      {button}
    </span>
  ) : (
    button
  );
}

/** A collapsed group: the heading is the affordance, the actions are inside. */
function GroupMenu({
  group,
  actions,
  busy,
  open,
  onOpenChange,
  onRun,
}: {
  group: ActionGroup;
  actions: ActionVerdict[];
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (id: string) => void;
}) {
  const { t } = useTranslation('actions');
  const groupLabel = (t as DynamicT)(`group.${group}`);

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => onOpenChange(!open)}
      >
        {groupLabel}
        <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label={groupLabel}
          className="absolute right-0 z-50 mt-1 min-w-52 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl backdrop-blur"
        >
          {actions.map((v) => {
            const Icon = actionIcon(v.action.icon);
            return (
              <button
                key={v.action.id}
                type="button"
                role="menuitem"
                disabled={!v.enabled}
                title={v.enabled ? undefined : (t as DynamicT)(reasonKey(v.reason))}
                onClick={() => onRun(v.action.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                  v.enabled
                    ? 'hover:bg-white/10'
                    : 'cursor-not-allowed text-muted-foreground opacity-60',
                  v.action.destructive && v.enabled && 'text-red-300 hover:bg-red-500/10',
                )}
              >
                {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
                {(t as DynamicT)(`action.${v.action.id}`)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/*
 * The key, not the translated string.
 *
 * `t` is deliberately NOT passed as an argument: i18next's `TFunction` carries
 * the whole typed key union as overloads, and structurally assigning it to a
 * plain `(k: string) => string` parameter made the compiler exhaust its default
 * heap. Returning a key and letting the caller's own `t` resolve it keeps that
 * type where it was inferred.
 */
function reasonKey(reason?: UnavailableReason): string {
  return reason === 'max_selection' ? 'reason.maxSelection' : 'reason.entityCapability';
}
