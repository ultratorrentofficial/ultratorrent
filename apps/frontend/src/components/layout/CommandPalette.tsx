import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft } from 'lucide-react';
import { tNav, type NavSearchEntry } from '@/components/layout/navigation';
import { cn } from '@/lib/utils';

/**
 * Command palette / menu search (Ctrl/Cmd+K). Operates over the already
 * RBAC- and module-filtered navigation entries, so it can never surface a link
 * the user isn't allowed to see. Keyboard: ↑/↓ move, Enter navigates, Esc closes.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  entries: NavSearchEntry[];
  onNavigate: (to: string) => void;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Only navigable destinations are searchable (action launchers are excluded).
  const navigable = useMemo(() => entries.filter((e) => e.to), [entries]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const decorated = navigable.map((e) => ({
      entry: e,
      label: tNav(t, 'items', e.label),
      group: tNav(t, 'groups', e.groupTitle),
      desc: e.descriptionKey ? tNav(t, 'descriptions', e.descriptionKey) : '',
    }));
    if (!q) return decorated;
    return decorated.filter(
      (d) =>
        d.label.toLowerCase().includes(q) ||
        d.group.toLowerCase().includes(q) ||
        d.desc.toLowerCase().includes(q),
    );
  }, [navigable, query, t]);

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
    const hit = results[idx];
    if (hit?.entry.to) {
      onNavigate(hit.entry.to);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
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

        {results.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">{tShell('command.empty')}</div>
        ) : (
          <ul ref={listRef} className="max-h-[50vh] overflow-y-auto scrollbar-thin p-1.5" role="listbox">
            {results.map((d, idx) => {
              const Icon = d.entry.icon;
              const isActive = idx === active;
              return (
                <li key={d.entry.id} data-idx={idx} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    onClick={() => choose(idx)}
                    onMouseEnter={() => setActive(idx)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-white/5',
                    )}
                  >
                    <Icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground">{d.label}</span>
                      {d.desc && <span className="truncate text-xs text-muted-foreground">{d.desc}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">{d.group}</span>
                    {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
