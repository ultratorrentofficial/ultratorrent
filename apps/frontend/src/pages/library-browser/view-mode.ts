/**
 * How the Library Browser lays out a library, remembered per user.
 *
 * Stored in `localStorage` rather than on the server, matching the existing
 * client-preference pattern (`analytics-filters.ts`, `useNavPersonalization.ts`).
 * A layout choice is per *browser*, not per account: the same person wants a
 * poster wall on a television and a table on a laptop, and a server-side
 * preference would fight that.
 */
export const VIEW_MODES = ['poster', 'grid', 'list', 'compact', 'table'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const DEFAULT_VIEW_MODE: ViewMode = 'poster';

/** Namespaced per library, so a music library can stay a list while films are a wall. */
export function viewModeKey(libraryId: string | null): string {
  return `ut.libraryBrowser.viewMode.${libraryId ?? 'all'}`;
}

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * Read a stored mode, falling back rather than throwing.
 *
 * `localStorage` throws in private browsing and when a quota is exceeded, and a
 * layout preference must never be the reason a library fails to render.
 */
export function readViewMode(libraryId: string | null): ViewMode {
  try {
    const raw = localStorage.getItem(viewModeKey(libraryId));
    return isViewMode(raw) ? raw : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

export function writeViewMode(libraryId: string | null, mode: ViewMode): void {
  try {
    localStorage.setItem(viewModeKey(libraryId), mode);
  } catch {
    // Preference lost, layout still correct for this session.
  }
}

/**
 * Column count for a poster wall at a given container width.
 *
 * Derived rather than fixed at breakpoints: the browser is the full content
 * area on a desktop and a narrow column on a phone, and a virtualized grid
 * needs an exact count to compute row heights — a CSS grid that reflows on its
 * own would desynchronise from the virtualizer and mis-measure the scroll
 * height.
 */
export function columnsForWidth(width: number, mode: ViewMode): number {
  if (mode === 'list' || mode === 'table') return 1;
  if (width <= 0) return 1;
  const target = mode === 'compact' ? 120 : mode === 'grid' ? 160 : 200;
  return Math.max(1, Math.floor(width / target));
}

/** Poster aspect ratio (2:3) plus room for the title beneath it. */
export function rowHeightFor(width: number, columns: number, mode: ViewMode): number {
  if (mode === 'list') return 72;
  if (mode === 'table') return 44;
  const cell = columns > 0 ? width / columns : width;
  const caption = mode === 'compact' ? 34 : 46;
  return Math.round(cell * 1.5) + caption;
}
