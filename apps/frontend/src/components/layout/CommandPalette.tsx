import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft, Pin, Star } from 'lucide-react';
import { tNav, type NavSearchEntry } from '@/components/layout/navigation';
import { cn } from '@/lib/utils';

interface Decorated {
  entry: NavSearchEntry;
  label: string;
  group: string;
  desc: string;
}
interface Section {
  key: string;
  /** Header label; omitted for the plain results / full list. */
  title?: string;
  rows: Decorated[];
}

/**
 * Command palette / menu search (Ctrl/Cmd+K). Operates over the already RBAC- and
 * module-filtered navigation entries, so it can never surface a link the user isn't
 * allowed to see. With an empty query it shows quick access — **Pinned**, **Recent**
 * and **Favorites** — and every row can be pinned/starred inline. Keyboard: ↑/↓ move,
 * Enter navigates, Esc closes.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
  onNavigate,
  pinned,
  favorites,
  recent,
  onTogglePin,
  onToggleFavorite,
}: {
  open: boolean;
  onClose: () => void;
  entries: NavSearchEntry[];
  onNavigate: (to: string) => void;
  pinned?: Set<string>;
  favorites?: Set<string>;
  recent?: string[];
  onTogglePin?: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Only navigable destinations are searchable (action launchers are excluded).
  const navigable = useMemo(() => entries.filter((e) => e.to), [entries]);
  const decorated = useMemo<Decorated[]>(
    () =>
      navigable.map((e) => ({
        entry: e,
        label: tNav(t, 'items', e.label),
        group: tNav(t, 'groups', e.groupTitle),
        desc: e.descriptionKey ? tNav(t, 'descriptions', e.descriptionKey) : '',
      })),
    [navigable, t],
  );
  const byId = useMemo(() => new Map(decorated.map((d) => [d.entry.id, d])), [decorated]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const rows = decorated.filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.group.toLowerCase().includes(q) ||
          d.desc.toLowerCase().includes(q),
      );
      return [{ key: 'results', rows }];
    }
    // Empty query → quick access. Resolve ids against the visible entries so a
    // shortcut to a now-hidden page simply drops out.
    const resolve = (ids: Iterable<string>) =>
      [...ids].map((id) => byId.get(id)).filter((d): d is Decorated => !!d);
    const quick: Section[] = [
      { key: 'pinned', title: tShell('command.pinned'), rows: resolve(pinned ?? []) },
      { key: 'recent', title: tShell('command.recent'), rows: resolve(recent ?? []) },
      { key: 'favorites', title: tShell('command.favorites'), rows: resolve(favorites ?? []) },
    ].filter((s) => s.rows.length > 0);
    // Nothing personalised yet → the full list, as before.
    return quick.length ? quick : [{ key: 'all', rows: decorated }];
  }, [query, decorated, byId, pinned, recent, favorites, tShell]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Reset on open; refocus the field.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the active row in view (scrollIntoView is absent in jsdom).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (idx: number) => {
    const hit = flat[idx];
    if (hit?.entry.to) {
      onNavigate(hit.entry.to);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let idx = -1; // running index across sections, for keyboard nav + data-idx

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={tShell('command.title')}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-xl glass shadow-card animate-scale-in" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tShell('command.placeholder')}
            aria-label={tShell('command.placeholder')}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">Esc</kbd>
        </div>

        {flat.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">{tShell('command.empty')}</div>
        ) : (
          <ul ref={listRef} className="max-h-[50vh] overflow-y-auto scrollbar-thin p-1.5" role="listbox">
            {sections.map((section) => (
              <li key={section.key}>
                {section.title && (
                  <p className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section.title}
                  </p>
                )}
                <ul>
                  {section.rows.map((d) => {
                    idx += 1;
                    const rowIdx = idx;
                    const Icon = d.entry.icon;
                    const isActive = rowIdx === active;
                    const isPinned = pinned?.has(d.entry.id) ?? false;
                    const isFav = favorites?.has(d.entry.id) ?? false;
                    return (
                      <li key={`${section.key}:${d.entry.id}`} data-idx={rowIdx} role="option" aria-selected={isActive}>
                        <div
                          className={cn(
                            'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                            isActive ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-white/5',
                          )}
                          onMouseEnter={() => setActive(rowIdx)}
                        >
                          <button type="button" onClick={() => choose(rowIdx)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                            <Icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-medium text-foreground">{d.label}</span>
                              {d.desc && <span className="truncate text-xs text-muted-foreground">{d.desc}</span>}
                            </span>
                            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">{d.group}</span>
                          </button>
                          {onToggleFavorite && (
                            <button
                              type="button"
                              onClick={() => onToggleFavorite(d.entry.id)}
                              aria-label={isFav ? tShell('command.unfavorite') : tShell('command.favorite')}
                              title={isFav ? tShell('command.unfavorite') : tShell('command.favorite')}
                              className={cn(
                                'shrink-0 rounded p-1 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                isFav ? 'text-warning opacity-100' : 'text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-foreground',
                              )}
                            >
                              <Star className={cn('h-3.5 w-3.5', isFav && 'fill-current')} />
                            </button>
                          )}
                          {onTogglePin && (
                            <button
                              type="button"
                              onClick={() => onTogglePin(d.entry.id)}
                              aria-label={isPinned ? tShell('command.unpin') : tShell('command.pin')}
                              title={isPinned ? tShell('command.unpin') : tShell('command.pin')}
                              className={cn(
                                'shrink-0 rounded p-1 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                isPinned ? 'text-primary opacity-100' : 'text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-foreground',
                              )}
                            >
                              <Pin className={cn('h-3.5 w-3.5', isPinned && 'fill-current')} />
                            </button>
                          )}
                          {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
