import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Users2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { RiskBadge } from './HouseholdShared';

export function HouseholdUsersPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['household', 'users', page], queryFn: () => api.mediaServerAnalytics.household.users(page) });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Users2 className="h-6 w-6" /> {t('household.users.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('household.users.subtitle')}</p>
      </div>

      {q.isLoading ? <CenteredSpinner /> : q.isError ? <ErrorState title={t('household.loadError')} onRetry={() => void q.refetch()} /> :
        (q.data?.items ?? []).length === 0 ? <Card><CardContent className="py-12"><EmptyState title={t('household.users.empty')} description={t('household.users.emptyHint')} /></CardContent></Card> : (
        <Card><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-white/10 text-left text-xs uppercase text-muted-foreground"><tr>
            <th className="px-4 py-2">{t('household.users.colUser')}</th>
            <th className="px-4 py-2">{t('household.users.colHome')}</th>
            <th className="px-4 py-2">{t('household.users.colConfidence')}</th>
            <th className="px-4 py-2">{t('household.users.colNetworks')}</th>
            <th className="px-4 py-2">{t('household.users.colRisk')}</th>
            <th className="px-4 py-2" />
          </tr></thead>
          <tbody>{(q.data?.items ?? []).map((u) => (
            <tr key={u.profileId} className="border-b border-white/5">
              <td className="px-4 py-2 font-medium">{u.displayName ?? u.subjectKey.slice(0, 8)}</td>
              <td className="px-4 py-2">
                {u.homeLocation ? <span>{u.homeLocation}{u.homeIsp ? <span className="block text-xs text-muted-foreground">{u.homeIsp}</span> : null}</span> : <span className="text-xs text-muted-foreground">{t('household.users.learning')}</span>}
              </td>
              <td className="px-4 py-2 tabular-nums">{u.homeLocation ? `${u.homeConfidence}%` : '—'}</td>
              <td className="px-4 py-2 tabular-nums">{u.additionalNetworks}</td>
              <td className="px-4 py-2"><RiskBadge level={u.riskLevel} score={u.riskScore} /></td>
              <td className="px-4 py-2 text-right"><Link to={`/media-server-analytics/household/users/${u.profileId}`}><Button variant="ghost" size="sm">{t('household.users.open')}</Button></Link></td>
            </tr>
          ))}</tbody>
        </table></div></CardContent></Card>
      )}

      {q.data && q.data.total > q.data.pageSize && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('household.prev')}</Button>
          <Button variant="secondary" size="sm" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage((p) => p + 1)}>{t('household.next')}</Button>
        </div>
      )}
    </div>
  );
}
