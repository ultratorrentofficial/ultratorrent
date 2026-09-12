import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Home, RefreshCw, Lock, Unlock } from 'lucide-react';
import { api, type HouseholdNetworkRow, type HouseholdNetworkType } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { RiskBadge, NetworkTypeBadge, ReasonList, watchHours } from './HouseholdShared';

const TYPES: HouseholdNetworkType[] = ['residential', 'mobile', 'hosting', 'vpn_proxy', 'unknown'];

export function HouseholdUserDetailPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['household', 'user', id], queryFn: () => api.mediaServerAnalytics.household.user(id) });

  const act = <T,>(fn: () => Promise<T>) =>
    fn().then(() => { toast.success(t('household.detail.saved')); void qc.invalidateQueries({ queryKey: ['household'] }); }).catch((e: Error) => toast.error(e.message));
  const H = api.mediaServerAnalytics.household;
  const relearn = useMutation({ mutationFn: () => H.relearn(id), onSuccess: () => act(async () => {}) });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('household.detail.loadError')} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const home = p.networks.find((n) => n.id === p.homeNetworkId) ?? null;

  return (
    <div className="space-y-6">
      <Link to="/media-server-analytics/household/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> {t('household.detail.back')}</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.displayName ?? p.subjectKey.slice(0, 8)}</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            {p.linkedAccounts.map((a) => <span key={a.kind + a.providerUserId} className="rounded border border-white/10 px-1.5 py-0.5 text-xs capitalize">{a.kind}</span>)}
            <RiskBadge level={p.riskLevel} score={p.riskScore} />
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => act(() => H.relearn(id))} disabled={relearn.isPending}><RefreshCw className="h-4 w-4" /> {t('household.detail.relearn')}</Button>
          {p.homeLocked
            ? <Button variant="secondary" size="sm" onClick={() => act(() => H.unlockHome(id))}><Unlock className="h-4 w-4" /> {t('household.detail.unlock')}</Button>
            : <Button variant="secondary" size="sm" onClick={() => act(() => H.lockHome(id))}><Lock className="h-4 w-4" /> {t('household.detail.lock')}</Button>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardContent className="space-y-2 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase text-muted-foreground"><Home className="h-4 w-4" /> {t('household.detail.home')}</h3>
          {home ? (
            <div className="text-sm">
              <div className="font-medium">{[home.city, home.country].filter(Boolean).join(', ') || t('household.detail.unplaced')}</div>
              <div className="text-muted-foreground">{home.isp ?? '—'}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t('household.detail.confidence', { pct: p.homeConfidence })} · {p.homeLocked ? t('household.detail.locked') : t('household.detail.autoLearned')}</div>
            </div>
          ) : <p className="text-sm text-muted-foreground">{t('household.detail.noHome')}</p>}
        </CardContent></Card>
        <Card><CardContent className="space-y-2 p-4">
          <h3 className="text-sm font-semibold uppercase text-muted-foreground">{t('household.detail.reasons')}</h3>
          <ReasonList reasons={p.reasons} />
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-white/10 text-left text-xs uppercase text-muted-foreground"><tr>
          <th className="px-3 py-2">{t('household.detail.network')}</th>
          <th className="px-3 py-2">{t('household.detail.type')}</th>
          <th className="px-3 py-2">{t('household.detail.days')}</th>
          <th className="px-3 py-2">{t('household.detail.plays')}</th>
          <th className="px-3 py-2">{t('household.detail.watch')}</th>
          <th className="px-3 py-2" />
        </tr></thead>
        <tbody>{p.networks.map((n) => <NetworkRow key={n.id} n={n} profileId={p.id} isHome={n.id === p.homeNetworkId} onAct={act} />)}</tbody>
      </table></div></CardContent></Card>
    </div>
  );
}

function NetworkRow({ n, profileId, isHome, onAct }: { n: HouseholdNetworkRow; profileId: string; isHome: boolean; onAct: <T>(fn: () => Promise<T>) => Promise<void> }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const H = api.mediaServerAnalytics.household;
  return (
    <tr className={`border-b border-white/5 ${n.ignored ? 'opacity-50' : ''}`}>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          {isHome && <Home className="h-3.5 w-3.5 text-success" aria-label={t('household.detail.home')} />}
          <span>{[n.city, n.country].filter(Boolean).join(', ') || (n.isp ?? n.fingerprint.slice(0, 16))}</span>
          {n.trusted && <span className="rounded border border-success/30 px-1 text-[10px] text-success">{t('household.detail.trusted')}</span>}
          {n.disposition && <span className="rounded border border-white/10 px-1 text-[10px] text-muted-foreground">{t(`household.disposition.${n.disposition}` as never)}</span>}
        </span>
        <span className="block text-xs text-muted-foreground">{n.isp ?? (n.asn ? `AS${n.asn}` : '')}</span>
      </td>
      <td className="px-3 py-2">
        <Select value={n.networkType} onChange={(e) => onAct(() => H.classifyNetwork(n.id, e.target.value as HouseholdNetworkType))} className="w-28 text-xs">
          {TYPES.map((ty) => <option key={ty} value={ty}>{t(`household.networkType.${ty}`)}</option>)}
        </Select>
        {n.networkType === 'unknown' ? null : <NetworkTypeBadge type={n.networkType} />}
      </td>
      <td className="px-3 py-2 tabular-nums">{n.distinctDays}</td>
      <td className="px-3 py-2 tabular-nums">{n.playCount}</td>
      <td className="px-3 py-2 tabular-nums">{watchHours(n.watchSeconds)}</td>
      <td className="px-3 py-2 text-right">
        <span className="flex flex-wrap justify-end gap-1">
          {!isHome && <Button variant="ghost" size="sm" onClick={() => onAct(() => H.setHome(profileId, n.id))}>{t('household.detail.setHome')}</Button>}
          <Button variant="ghost" size="sm" onClick={() => onAct(() => H.trustNetwork(n.id, !n.trusted))}>{n.trusted ? t('household.detail.untrust') : t('household.detail.trust')}</Button>
          <Button variant="ghost" size="sm" onClick={() => onAct(() => H.dispositionNetwork(n.id, n.disposition === 'travel' ? null : 'travel'))}>{t('household.detail.travel')}</Button>
          <Button variant="ghost" size="sm" onClick={() => onAct(() => H.ignoreNetwork(n.id, !n.ignored))}>{n.ignored ? t('household.detail.unignore') : t('household.detail.ignore')}</Button>
        </span>
      </td>
    </tr>
  );
}
