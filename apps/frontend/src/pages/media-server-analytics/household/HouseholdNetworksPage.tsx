import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Network } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { NetworkTypeBadge, watchHours } from './HouseholdShared';

export function HouseholdNetworksPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({ queryKey: ['household', 'networks'], queryFn: () => api.mediaServerAnalytics.household.networks() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Network className="h-6 w-6" /> {t('household.networks.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('household.networks.subtitle')}</p>
      </div>
      {q.isLoading ? <CenteredSpinner /> : q.isError ? <ErrorState title={t('household.loadError')} onRetry={() => void q.refetch()} /> :
        (q.data ?? []).length === 0 ? <Card><CardContent className="py-12"><EmptyState title={t('household.networks.empty')} /></CardContent></Card> : (
        <Card><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-white/10 text-left text-xs uppercase text-muted-foreground"><tr>
            <th className="px-4 py-2">{t('household.networks.colLocation')}</th>
            <th className="px-4 py-2">{t('household.networks.colIsp')}</th>
            <th className="px-4 py-2">{t('household.networks.colType')}</th>
            <th className="px-4 py-2">{t('household.networks.colUsers')}</th>
            <th className="px-4 py-2">{t('household.networks.colPlays')}</th>
            <th className="px-4 py-2">{t('household.networks.colWatch')}</th>
          </tr></thead>
          <tbody>{(q.data ?? []).map((n) => (
            <tr key={n.fingerprint} className="border-b border-white/5">
              <td className="px-4 py-2">{n.location ?? '—'}</td>
              <td className="px-4 py-2 text-muted-foreground">{n.isp ?? (n.asn ? `AS${n.asn}` : '—')}</td>
              <td className="px-4 py-2"><NetworkTypeBadge type={n.networkType} /></td>
              <td className="px-4 py-2 tabular-nums">{n.users}</td>
              <td className="px-4 py-2 tabular-nums">{n.plays}</td>
              <td className="px-4 py-2 tabular-nums">{watchHours(n.watchSeconds)}</td>
            </tr>
          ))}</tbody>
        </table></div></CardContent></Card>
      )}
      <p className="text-xs text-muted-foreground">{t('household.networks.note')}</p>
    </div>
  );
}
