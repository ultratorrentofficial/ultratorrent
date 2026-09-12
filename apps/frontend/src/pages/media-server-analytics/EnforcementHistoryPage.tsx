import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api, type StreamEnforcementEvent } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatDateTime } from '@/lib/format';

const ACTIONS = ['terminate_newest', 'terminate_oldest', 'warn', 'log'] as const;
const RESULTS = ['success', 'failure', 'skipped'] as const;

/** Enforcement History — every enforcement decision, newest first, with filters. */
export function EnforcementHistoryPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const [filters, setFilters] = useState<{ provider: string; action: string; result: string; from: string; to: string }>({ provider: '', action: '', result: '', from: '', to: '' });
  const [page, setPage] = useState(1);

  const params: Record<string, string> = { page: String(page), pageSize: '50' };
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;

  const q = useQuery({ queryKey: ['streamControl', 'events', params], queryFn: () => api.mediaServerAnalytics.streamControl.events(params) });
  const set = (k: keyof typeof filters, v: string) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldAlert className="h-6 w-6" /> {t('streamControl.history.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('streamControl.history.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Select value={filters.provider} onChange={(e) => set('provider', e.target.value)} className="w-36">
          <option value="">{t('streamControl.history.allProviders')}</option>
          {['plex', 'jellyfin', 'emby'].map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={filters.action} onChange={(e) => set('action', e.target.value)} className="w-44">
          <option value="">{t('streamControl.history.allActions')}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{t(`streamControl.action.${a}`)}</option>)}
        </Select>
        <Select value={filters.result} onChange={(e) => set('result', e.target.value)} className="w-36">
          <option value="">{t('streamControl.history.allResults')}</option>
          {RESULTS.map((r) => <option key={r} value={r}>{t(`streamControl.result.${r}`)}</option>)}
        </Select>
        <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className="w-40" />
        <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className="w-40" />
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('streamControl.history.loadError')} onRetry={() => void q.refetch()} />
      ) : (q.data?.items ?? []).length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title={t('streamControl.history.empty')} /></CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-white/10 text-left uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">{t('streamControl.history.colTime')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colProvider')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colMedia')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colClient')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colStreams')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colAction')}</th>
                    <th className="px-3 py-2">{t('streamControl.history.colResult')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(q.data?.items ?? []).map((e: StreamEnforcementEvent) => (
                    <tr key={e.id} className="border-b border-white/5">
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDateTime(e.detectedAt)}</td>
                      <td className="px-3 py-2">{e.provider}</td>
                      <td className="px-3 py-2">{e.mediaTitle ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{[e.client, e.device].filter(Boolean).join(' / ') || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{e.observedStreams} / {e.configuredLimit}</td>
                      <td className="px-3 py-2">{t(`streamControl.action.${e.action}` as never, { defaultValue: e.action })}</td>
                      <td className="px-3 py-2">
                        <span className={resultClass(e.result)}>{t(`streamControl.result.${e.result}` as never, { defaultValue: e.result })}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {q.data && q.data.total > q.data.pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('streamControl.history.pageInfo', { page: q.data.page, total: q.data.total })}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('streamControl.history.prev')}</Button>
            <Button variant="secondary" size="sm" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage((p) => p + 1)}>{t('streamControl.history.next')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function resultClass(result: string): string {
  const base = 'rounded px-1.5 py-0.5 text-[10px] font-medium border ';
  if (result === 'success') return base + 'text-success border-success/30';
  if (result === 'failure') return base + 'text-destructive border-destructive/40';
  return base + 'text-muted-foreground border-white/10';
}
