import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Users2, ChevronRight, ChevronDown, Home } from 'lucide-react';
import { api, type HouseholdUserRow, type HouseholdNetworkRow, type HouseholdNetworkType } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { RiskBadge } from './HouseholdShared';

const watchHours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);

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
          <tbody>{(q.data?.items ?? []).map((u) => <UserRow key={u.profileId} u={u} />)}</tbody>
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

/** One user row, expandable to reveal the networks that user has streamed from —
 *  so an admin can analyse the sharing pattern in place, before opening the review
 *  queue. The network list is fetched lazily (only when expanded) and read-only;
 *  the trust/ignore/set-home actions stay on the user's profile page. */
function UserRow({ u }: { u: HouseholdUserRow }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ['household', 'user', u.profileId],
    queryFn: () => api.mediaServerAnalytics.household.user(u.profileId),
    enabled: open,
  });
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <tr className="border-b border-white/5">
        <td className="px-4 py-2 font-medium">{u.displayName ?? u.subjectKey.slice(0, 8)}</td>
        <td className="px-4 py-2">
          {u.homeLocation ? <span>{u.homeLocation}{u.homeIsp ? <span className="block text-xs text-muted-foreground">{u.homeIsp}</span> : null}</span> : <span className="text-xs text-muted-foreground">{t('household.users.learning')}</span>}
        </td>
        <td className="px-4 py-2 tabular-nums">{u.homeLocation ? `${u.homeConfidence}%` : '—'}</td>
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? t('household.users.hideNetworks') : t('household.users.showNetworks')}
            className="flex items-center gap-1 tabular-nums hover:text-foreground"
            title={open ? t('household.users.hideNetworks') : t('household.users.showNetworks')}
          >
            <Chevron className="h-3.5 w-3.5" />
            {u.additionalNetworks}
          </button>
        </td>
        <td className="px-4 py-2"><RiskBadge level={u.riskLevel} score={u.riskScore} /></td>
        <td className="px-4 py-2 text-right"><Link to={`/media-server-analytics/household/users/${u.profileId}`}><Button variant="ghost" size="sm">{t('household.users.open')}</Button></Link></td>
      </tr>
      {open && (
        <tr className="border-b border-white/5 bg-white/[0.02]">
          <td colSpan={6} className="px-4 py-3">
            {detail.isLoading ? <CenteredSpinner /> :
              detail.isError ? <ErrorState title={t('household.loadError')} onRetry={() => void detail.refetch()} /> :
              (detail.data?.networks ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{t('household.users.noNetworks')}</p> : (
              <UserNetworks networks={detail.data!.networks} homeNetworkId={detail.data!.homeNetworkId} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function UserNetworks({ networks, homeNetworkId }: { networks: HouseholdNetworkRow[]; homeNetworkId: string | null }) {
  const { t } = useTranslation('mediaServerAnalytics');
  return (
    <div className="overflow-x-auto rounded border border-white/10">
      <table className="w-full text-xs">
        <thead className="border-b border-white/10 text-left uppercase text-muted-foreground"><tr>
          <th className="px-3 py-1.5">{t('household.detail.network')}</th>
          <th className="px-3 py-1.5">{t('household.detail.type')}</th>
          <th className="px-3 py-1.5">{t('household.detail.days')}</th>
          <th className="px-3 py-1.5">{t('household.detail.plays')}</th>
          <th className="px-3 py-1.5">{t('household.detail.watch')}</th>
        </tr></thead>
        <tbody>{networks.map((n) => (
          <tr key={n.id} className={`border-b border-white/5 last:border-0 ${n.ignored ? 'opacity-50' : ''}`}>
            <td className="px-3 py-1.5">
              <span className="flex flex-wrap items-center gap-2">
                {n.id === homeNetworkId && <Home className="h-3 w-3 text-success" aria-label={t('household.detail.home')} />}
                <span>{[n.city, n.country].filter(Boolean).join(', ') || (n.isp ?? n.fingerprint.slice(0, 16))}</span>
                {n.trusted && <span className="rounded border border-success/30 px-1 text-[10px] text-success">{t('household.detail.trusted')}</span>}
                {n.disposition && <span className="rounded border border-white/10 px-1 text-[10px] text-muted-foreground">{t(`household.disposition.${n.disposition}` as never)}</span>}
              </span>
              <span className="block text-[11px] text-muted-foreground">{n.isp ?? (n.asn ? `AS${n.asn}` : '')}</span>
            </td>
            <td className="px-3 py-1.5">{t(`household.networkType.${n.networkType}` as `household.networkType.${HouseholdNetworkType}`)}</td>
            <td className="px-3 py-1.5 tabular-nums">{n.distinctDays}</td>
            <td className="px-3 py-1.5 tabular-nums">{n.playCount}</td>
            <td className="px-3 py-1.5 tabular-nums">{watchHours(n.watchSeconds)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
