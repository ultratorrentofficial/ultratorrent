import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft, Pin, Star, Loader2, X } from 'lucide-react';
import { tNav, type NavIcon, type NavSearchEntry } from '@/components/layout/navigation';
import { fuzzyScore } from '@/lib/fuzzy';
import { cn } from '@/lib/utils';

/** A quick action — a command that runs rather than navigating (or navigates itself). */
export interface PaletteAction {
  id: string;
  label: string;
  icon: NavIcon;
  run: () => void;
  /** Extra words to match on (e.g. synonyms). */
  keywords?: string;
  /** Workspace this action belongs to (for scoped search). */
  scope?: string;
}

/** One matched entity (a library, media item, …) from an async source. */
export interface PaletteEntity {
  id: string;
  label: string;
  sublabel?: string;
  icon: NavIcon;
  to: string;
}

/** An async entity search source — a section of live results (movies, libraries, …). */
export interface PaletteEntitySource {
  key: string;
  title: string;
  search: (query: string) => Promise<PaletteEntity[]>;
  /** Workspace this source belongs to (for scoped search). */
  scope?: string;
}

interface Decorated {
  entry: NavSearchEntry;
  label: string;
  group: string;
  desc: string;
}

type Row =
  | { kind: 'page'; id: string; label: string; sub?: string; icon: NavIcon; to: string }
  | { kind: 'action'; id: string; label: string; icon: NavIcon; run: () => void }
  | { kind: 'entity'; id: string; label: string; sub?: string; icon: NavIcon; to: string };

interface Section {
  key: string;
  title?: string;
  rows: Row[];
  /** Pin/star affordances only apply to page rows (quick-access personalisation). */
  personalise?: boolean;
  loading?: boolean;
}

const MIN_ENTITY_QUERY = 2;

/**
 * Command palette / menu search (Ctrl/Cmd+K). Searches, in one place:
 * **pages** (RBAC-filtered nav), **quick actions**, and live **entities** (media
 * items, libraries) from async sources. Empty query shows quick access — Pinned /
 * Recent / Favorites. Every page row can be pinned/starred inline. Keyboard: ↑/↓
 * move, Enter activates, Esc closes.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
  onNavigate,
  actions = [],
  entitySources = [],
  pinned,
  favorites,
  recent,
  onTogglePin,
  onToggleFavorite,
  scopeId,
  scopeLabel,
}: {
  open: boolean;
  onClose: () => void;
  entries: NavSearchEntry[];
  onNavigate: (to: string) => void;
  actions?: PaletteAction[];
  entitySources?: PaletteEntitySource[];
  pinned?: Set<string>;
  favorites?: Set<string>;
  recent?: string[];
  onTogglePin?: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  /** When set, the palette offers a toggle to scope results to this workspace. */
  scopeId?: string;
  scopeLabel?: string;
}) {
  const { t } = useTranslation('nav');
  const { t: tShell } = useTranslation('shell');
  const [query, setQuery] = useState('');
  const [scoped, setScoped] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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

  // Scoped search: when the user limits the palette to the active workspace, pages,
  // actions and entity sources are all filtered to that workspace's scope.
  const scopeActive = scoped && !!scopeId;
  const activeSources = useMemo(
    () => (scopeActive ? entitySources.filter((s) => s.scope === scopeId) : entitySources),
    [scopeActive, scopeId, entitySources],
  );

  // --- async entity search (debounced, provider-free of react-query so the palette
  // stays self-contained) -------------------------------------------------------
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(id);
  }, [query]);
  const [entityHits, setEntityHits] = useState<Record<string, PaletteEntity[]>>({});
  const [entityLoading, setEntityLoading] = useState(false);
  // Key the effect on the sources' identity by content, not array reference — a
  // default `[]` prop is a fresh reference each render and would otherwise re-run
  // this effect (and its setState) forever.
  const sourceKeys = activeSources.map((s) => s.key).join(',');
  useEffect(() => {
    const q = debounced.trim();
    if (!open || q.length < MIN_ENTITY_QUERY || activeSources.length === 0) {
      // Functional bail-out: return the SAME reference when already empty so React
      // skips the re-render (otherwise this loops).
      setEntityHits((h) => (Object.keys(h).length ? {} : h));
      setEntityLoading((l) => (l ? false : l));
      return;
    }
    let cancelled = false;
    setEntityLoading(true);
    Promise.all(
      activeSources.map(async (s) => [s.key, await s.search(q).catch(() => [] as PaletteEntity[])] as const),
    ).then((pairs) => {
      if (cancelled) return;
      setEntityHits(Object.fromEntries(pairs));
      setEntityLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, open, sourceKeys]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Quick access. Resolve ids against the visible entries so a shortcut to a
      // now-hidden page drops out.
      const resolve = (ids: Iterable<string>): Row[] =>
        [...ids]
          .map((id) => byId.get(id))
          .filter((d): d is Decorated => !!d)
          .map((d) => ({ kind: 'page' as const, id: d.entry.id, label: d.label, sub: d.desc, icon: d.entry.icon, to: d.entry.to! }));
      const quick: Section[] = [
        { key: 'pinned', title: tShell('command.pinned'), rows: resolve(pinned ?? []), personalise: true },
        { key: 'recent', title: tShell('command.recent'), rows: resolve(recent ?? []), personalise: true },
        { key: 'favorites', title: tShell('command.favorites'), rows: resolve(favorites ?? []), personalise: true },
      ].filter((s) => s.rows.length > 0);
      if (quick.length) return quick;
      // Nothing personalised → the full page list.
      return [
        {
          key: 'all',
          rows: decorated.map((d) => ({ kind: 'page', id: d.entry.id, label: d.label, sub: d.desc, icon: d.entry.icon, to: d.entry.to! })),
          personalise: true,
        },
      ];
    }

    const out: Section[] = [];

    // Score a row: fuzzy on the LABEL (the field worth being lenient on), plus a
    // precise substring fallback on auxiliary fields (group/desc/keywords) so a
    // scattered subsequence buried in a long description doesn't surface noise.
    const rank = (label: string, ...aux: (string | undefined)[]): number | null => {
      const s = fuzzyScore(q, label);
      if (s !== null) return s;
      return aux.some((a) => a?.toLowerCase().includes(q)) ? 1 : null;
    };

    const actionRows: Row[] = actions
      .filter((a) => !scopeActive || a.scope === scopeId)
      .map((a) => ({ a, score: rank(a.label, a.keywords) }))
      .filter((x): x is { a: PaletteAction; score: number } => x.score !== null)
      .sort((x, y) => y.score - x.score)
      .map(({ a }) => ({ kind: 'action', id: a.id, label: a.label, icon: a.icon, run: a.run }));
    if (actionRows.length) out.push({ key: 'actions', title: tShell('command.actions'), rows: actionRows });

    const pageRows: Row[] = decorated
      .filter((d) => !scopeActive || d.entry.groupId === scopeId)
      .map((d) => ({ d, score: rank(d.label, d.group, d.desc) }))
      .filter((x): x is { d: Decorated; score: number } => x.score !== null)
      .sort((x, y) => y.score - x.score)
      .map(({ d }) => ({ kind: 'page', id: d.entry.id, label: d.label, sub: d.group, icon: d.entry.icon, to: d.entry.to! }));
    if (pageRows.length) out.push({ key: 'pages', title: tShell('command.pages'), rows: pageRows, personalise: true });

    for (const src of activeSources) {
      const hits = entityHits[src.key] ?? [];
      const loading = entityLoading && debounced.trim().length >= MIN_ENTITY_QUERY;
      if (hits.length === 0 && !loading) continue;
      out.push({
        key: src.key,
        title: src.title,
        loading,
        rows: hits.map((e) => ({ kind: 'entity', id: `${src.key}:${e.id}`, label: e.label, sub: e.sublabel, icon: e.icon, to: e.to })),
      });
    }

    return out;
  }, [query, decorated, byId, pinned, recent, favorites, actions, activeSources, scopeActive, scopeId, entityHits, entityLoading, debounced, tShell]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setActive(0);
      setScoped(false);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'action') row.run();
    else onNavigate(row.to);
    onClose();
  };

  const canScope = !!scopeId && !!scopeLabel;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(flat[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Escape first clears an active scope, then closes.
      if (scoped) setScoped(false);
      else onClose();
    } else if (e.key === 'Tab' && canScope) {
      // Tab toggles the workspace scope.
      e.preventDefault();
      setScoped((v) => !v);
    } else if (e.key === 'Backspace' && scoped && query === '') {
      // Backspace on an empty query lifts the scope.
      setScoped(false);
    }
  };

  const showEmpty = flat.length === 0 && !entityLoading;
  let idx = -1;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={tShell('command.title')}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-xl glass shadow-card animate-scale-in" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          {scopeActive && (
            <button
              type="button"
              onClick={() => setScoped(false)}
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary"
              aria-label={tShell('command.scopeClear', { name: scopeLabel })}
              title={tShell('command.scopeClear', { name: scopeLabel })}
            >
              {scopeLabel}
              <X className="h-3 w-3" />
            </button>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={scopeActive ? tShell('command.scopedPlaceholder', { name: scopeLabel }) : tShell('command.placeholder')}
            aria-label={tShell('command.placeholder')}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {entityLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
          {canScope && !scopeActive && (
            <button
              type="button"
              onClick={() => setScoped(true)}
              className="hidden shrink-0 items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground sm:flex"
              title={tShell('command.scopeTo', { name: scopeLabel })}
            >
              <kbd>Tab</kbd> {scopeLabel}
            </button>
          )}
          <kbd className="hidden shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">Esc</kbd>
        </div>

        {showEmpty ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">{tShell('command.empty')}</div>
        ) : (
          <ul ref={listRef} className="max-h-[50vh] overflow-y-auto scrollbar-thin p-1.5" role="listbox">
            {sections.map((section) => (
              <li key={section.key}>
                {section.title && (
                  <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section.title}
                    {section.loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                  </p>
                )}
                <ul>
                  {section.rows.map((row) => {
                    idx += 1;
                    const rowIdx = idx;
                    const Icon = row.icon;
                    const isActive = rowIdx === active;
                    const canPersonalise = section.personalise && row.kind === 'page';
                    const isPinned = canPersonalise && (pinned?.has(row.id) ?? false);
                    const isFav = canPersonalise && (favorites?.has(row.id) ?? false);
                    return (
                      <li key={`${section.key}:${row.id}`} data-idx={rowIdx} role="option" aria-selected={isActive}>
                        <div
                          className={cn(
                            'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                            isActive ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-white/5',
                          )}
                          onMouseEnter={() => setActive(rowIdx)}
                        >
                          <button type="button" onClick={() => activate(row)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                            <Icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-medium text-foreground">{row.label}</span>
                              {row.kind !== 'action' && row.sub && <span className="truncate text-xs text-muted-foreground">{row.sub}</span>}
                            </span>
                          </button>
                          {canPersonalise && onToggleFavorite && (
                            <button
                              type="button"
                              onClick={() => onToggleFavorite(row.id)}
                              aria-label={isFav ? tShell('command.unfavorite') : tShell('command.favorite')}
                              title={isFav ? tShell('command.unfavorite') : tShell('command.favorite')}
                              className={cn('shrink-0 rounded p-1 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', isFav ? 'text-warning opacity-100' : 'text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-foreground')}
                            >
                              <Star className={cn('h-3.5 w-3.5', isFav && 'fill-current')} />
                            </button>
                          )}
                          {canPersonalise && onTogglePin && (
                            <button
                              type="button"
                              onClick={() => onTogglePin(row.id)}
                              aria-label={isPinned ? tShell('command.unpin') : tShell('command.pin')}
                              title={isPinned ? tShell('command.unpin') : tShell('command.pin')}
                              className={cn('shrink-0 rounded p-1 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', isPinned ? 'text-primary opacity-100' : 'text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-foreground')}
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
