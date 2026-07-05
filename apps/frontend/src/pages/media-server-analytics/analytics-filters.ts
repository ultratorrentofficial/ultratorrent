import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaAnalyticsFilter } from '@/lib/api';

/** Date-range presets. `days: 0` means all-time. */
export const RANGE_PRESETS = [
  { key: 'today', days: 1 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'year', days: 365 },
  { key: 'all', days: 0 },
] as const;

export type RangeKey = (typeof RANGE_PRESETS)[number]['key'];

/** Media-type filter options (value '' = all). Mirrors watch-history mediaType values. */
export const MEDIA_TYPE_OPTIONS = ['', 'movie', 'episode', 'track', 'other'] as const;
export type MediaTypeOption = (typeof MEDIA_TYPE_OPTIONS)[number];

/** Auto-refresh interval options, in milliseconds. `0` = off. */
export const REFRESH_OPTIONS = [
  { key: 'off', ms: 0 },
  { key: '15s', ms: 15_000 },
  { key: '30s', ms: 30_000 },
  { key: '60s', ms: 60_000 },
  { key: '5m', ms: 300_000 },
] as const;

export type RefreshKey = (typeof REFRESH_OPTIONS)[number]['key'];

export interface AnalyticsFilterState {
  range: RangeKey;
  mediaType: MediaTypeOption;
  refresh: RefreshKey;
}

const STORAGE_KEY = 'msa.filters.v1';
const DEFAULTS: AnalyticsFilterState = { range: '30d', mediaType: '', refresh: '30s' };

function load(): AnalyticsFilterState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AnalyticsFilterState>;
    return {
      range: RANGE_PRESETS.some((r) => r.key === parsed.range) ? (parsed.range as RangeKey) : DEFAULTS.range,
      mediaType: MEDIA_TYPE_OPTIONS.includes(parsed.mediaType as MediaTypeOption)
        ? (parsed.mediaType as MediaTypeOption)
        : DEFAULTS.mediaType,
      refresh: REFRESH_OPTIONS.some((r) => r.key === parsed.refresh) ? (parsed.refresh as RefreshKey) : DEFAULTS.refresh,
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Dashboard filter state, persisted to localStorage. Exposes the raw UI state
 * plus a derived `filter` (days/mediaType) for the API and `refreshMs` for
 * react-query refetch intervals.
 */
export function useAnalyticsFilters() {
  const [state, setState] = useState<AnalyticsFilterState>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable (private mode / quota) — filters still work in-memory */
    }
  }, [state]);

  const set = useCallback(<K extends keyof AnalyticsFilterState>(key: K, value: AnalyticsFilterState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const filter = useMemo<MediaAnalyticsFilter>(() => {
    const days = RANGE_PRESETS.find((r) => r.key === state.range)?.days ?? 0;
    return {
      ...(days > 0 ? { days } : {}),
      ...(state.mediaType ? { mediaType: state.mediaType } : {}),
    };
  }, [state.range, state.mediaType]);

  const refreshMs = useMemo(
    () => REFRESH_OPTIONS.find((r) => r.key === state.refresh)?.ms ?? 0,
    [state.refresh],
  );

  /** Stable key fragment for react-query cache keys. */
  const filterKey = useMemo(() => `${state.range}:${state.mediaType || 'all'}`, [state.range, state.mediaType]);

  return { state, set, filter, refreshMs, filterKey } as const;
}
