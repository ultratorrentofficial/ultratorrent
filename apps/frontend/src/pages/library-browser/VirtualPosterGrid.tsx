import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { columnsForWidth, rowHeightFor, type ViewMode } from './view-mode';

/**
 * A windowed grid over an arbitrarily long list.
 *
 * Only the rows intersecting the viewport are mounted, so the DOM cost is a
 * function of the window rather than the library: the brief calls for libraries
 * of 500 000+ items, and a plain `.map()` over even a few thousand posters
 * janks on a television.
 *
 * Rows, not cells, are virtualized. A cell-level virtualizer buys nothing here —
 * a row is at most a dozen posters wide — and it would break keyboard order and
 * text selection across a row.
 *
 * The column count is computed from a measured width rather than left to CSS.
 * A `grid-template-columns: repeat(auto-fill, …)` would reflow on its own, and
 * the virtualizer would then be sizing rows it cannot see — the scrollbar would
 * lie and items would overlap at the seams.
 */
export function VirtualPosterGrid<T>({
  items,
  mode,
  renderItem,
  itemKey,
  onEndReached,
  endReachedThreshold = 8,
  emptyState,
  overscan = 3,
}: {
  items: T[];
  mode: ViewMode;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string;
  /** Called when the last rows come into view — server pagination, not a fetch-all. */
  onEndReached?: () => void;
  /** How many rows from the end to prefetch at. */
  endReachedThreshold?: number;
  emptyState?: ReactNode;
  overscan?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // ResizeObserver rather than a window listener: the browser sits inside a
  // shell whose sidebar collapses, which changes our width without the window
  // resizing at all.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const columns = columnsForWidth(width, mode);
  const rowCount = Math.ceil(items.length / columns);
  const rowHeight = rowHeightFor(width, columns, mode);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  // Re-measure when the layout changes underneath the virtualizer; without this
  // a mode switch keeps the old row height until the next scroll.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleRow = virtualRows.length ? virtualRows[virtualRows.length - 1].index : 0;

  useEffect(() => {
    if (!onEndReached || !rowCount) return;
    if (lastVisibleRow >= rowCount - endReachedThreshold) onEndReached();
  }, [lastVisibleRow, rowCount, endReachedThreshold, onEndReached]);

  if (!items.length && emptyState) {
    return <div ref={scrollRef} className="h-full overflow-y-auto">{emptyState}</div>;
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-thin" data-testid="virtual-grid">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualRows.map((row) => {
          const start = row.index * columns;
          const rowItems = items.slice(start, start + columns);
          return (
            <div
              key={row.key}
              data-row={row.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: row.size,
                transform: `translateY(${row.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: mode === 'compact' ? '0.5rem' : '0.75rem',
              }}
            >
              {rowItems.map((item, i) => (
                <div key={itemKey(item, start + i)}>{renderItem(item, start + i)}</div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
