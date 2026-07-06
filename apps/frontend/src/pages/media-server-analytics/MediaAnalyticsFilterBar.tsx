import { useTranslation } from 'react-i18next';
import { Download, RefreshCw } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MEDIA_TYPE_OPTIONS,
  RANGE_PRESETS,
  REFRESH_OPTIONS,
  type AnalyticsFilterState,
} from './analytics-filters';

/**
 * Dashboard filter bar: date range, media type, and auto-refresh interval
 * selectors plus a manual refresh button. State is owned by the parent
 * (persisted via useAnalyticsFilters); this component is presentational.
 */
export function MediaAnalyticsFilterBar({
  state,
  onChange,
  onRefresh,
  refreshing,
  onExport,
  exporting,
  servers = [],
  libraries = [],
  users = [],
}: {
  state: AnalyticsFilterState;
  onChange: <K extends keyof AnalyticsFilterState>(key: K, value: AnalyticsFilterState[K]) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onExport?: () => void;
  exporting?: boolean;
  servers?: { value: string; label: string }[];
  libraries?: { value: string; label: string }[];
  users?: { value: string; label: string }[];
}) {
  const { t } = useTranslation('mediaServerAnalytics');

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <Field label={t('filters.range')}>
        <Select
          value={state.range}
          onChange={(e) => onChange('range', e.target.value as AnalyticsFilterState['range'])}
          className="h-9"
          options={RANGE_PRESETS.map((r) => ({ value: r.key, label: t(`filters.ranges.${r.key}`) }))}
        />
      </Field>

      <Field label={t('filters.mediaType')}>
        <Select
          value={state.mediaType}
          onChange={(e) => onChange('mediaType', e.target.value as AnalyticsFilterState['mediaType'])}
          className="h-9"
          options={MEDIA_TYPE_OPTIONS.map((v) => ({
            value: v,
            label: v ? t(`filters.mediaTypes.${v}`) : t('filters.mediaTypes.all'),
          }))}
        />
      </Field>

      {servers.length > 0 && (
        <Field label={t('filters.server')}>
          <Select
            value={state.connectionId}
            onChange={(e) => onChange('connectionId', e.target.value)}
            className="h-9"
            options={[{ value: '', label: t('filters.allServers') }, ...servers]}
          />
        </Field>
      )}

      {libraries.length > 0 && (
        <Field label={t('filters.library')}>
          <Select
            value={state.libraryName}
            onChange={(e) => onChange('libraryName', e.target.value)}
            className="h-9"
            options={[{ value: '', label: t('filters.allLibraries') }, ...libraries]}
          />
        </Field>
      )}

      {users.length > 0 && (
        <Field label={t('filters.user')}>
          <Select
            value={state.userName}
            onChange={(e) => onChange('userName', e.target.value)}
            className="h-9"
            options={[{ value: '', label: t('filters.allUsers') }, ...users]}
          />
        </Field>
      )}

      <Field label={t('filters.refresh')}>
        <Select
          value={state.refresh}
          onChange={(e) => onChange('refresh', e.target.value as AnalyticsFilterState['refresh'])}
          className="h-9"
          options={REFRESH_OPTIONS.map((r) => ({ value: r.key, label: t(`filters.refreshes.${r.key}`) }))}
        />
      </Field>

      <Button variant="outline" size="sm" onClick={onRefresh} className="h-9" disabled={refreshing}>
        <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        {t('filters.refreshNow')}
      </Button>

      {onExport && (
        <Button variant="subtle" size="sm" onClick={onExport} className="h-9" loading={exporting}>
          <Download className="h-4 w-4" />
          {t('filters.exportCsv')}
        </Button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[8rem] flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
