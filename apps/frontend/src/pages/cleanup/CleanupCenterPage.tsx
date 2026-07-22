import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { FileCog, Gauge, ClipboardCheck, Trash2, ShieldCheck, Recycle } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner } from '@/components/ui/feedback';
import { formatBytes } from '@/lib/format';
import { CleanupHeader, toNum } from './_shared';

/**
 * The Media-workspace landing page for cleanup. Read-only: a set of headline
 * counts and links into the five working surfaces. Every figure is derived from
 * the same endpoints the detail pages use, so nothing here can disagree with them.
 */
export function CleanupCenterPage() {
  const { t } = useTranslation('cleanup');

  const policies = useQuery({ queryKey: ['cleanup', 'policies', 'all'], queryFn: () => api.cleanup.listPolicies({ pageSize: 200 }) });
  const plans = useQuery({ queryKey: ['cleanup', 'plans', 'pending'], queryFn: () => api.cleanup.listPlans({ status: 'pending_approval', pageSize: 1 }) });
  const quarantine = useQuery({ queryKey: ['cleanup', 'quarantine', 'held'], queryFn: () => api.cleanup.listQuarantine({ status: 'quarantined', pageSize: 200 }) });
  const protections = useQuery({ queryKey: ['cleanup', 'protections', 'active'], queryFn: () => api.cleanup.listProtections({ pageSize: 1 }) });

  if (policies.isLoading) return <CenteredSpinner />;

  const policyRows = policies.data?.items ?? [];
  const enabledCount = policyRows.filter((p) => p.enabled).length;
  const quarantineRows = quarantine.data?.items ?? [];
  const quarantineBytes = quarantineRows.reduce((n, q) => n + toNum(q.fileSizeBytes), 0);

  const tiles = [
    { to: '/media/cleanup/policies', icon: FileCog, title: t('center.tile.policies'), desc: t('center.tile.policiesDesc') },
    { to: '/media/cleanup/runs', icon: Gauge, title: t('center.tile.runs'), desc: t('center.tile.runsDesc') },
    { to: '/media/cleanup/plans', icon: ClipboardCheck, title: t('center.tile.plans'), desc: t('center.tile.plansDesc') },
    { to: '/media/cleanup/quarantine', icon: Trash2, title: t('center.tile.quarantine'), desc: t('center.tile.quarantineDesc') },
    { to: '/media/cleanup/protections', icon: ShieldCheck, title: t('center.tile.protections'), desc: t('center.tile.protectionsDesc') },
  ];

  const stats = [
    { label: t('center.stat.policies'), value: policyRows.length },
    { label: t('center.stat.enabled'), value: enabledCount },
    { label: t('center.stat.pendingApproval'), value: plans.data?.total ?? 0, tone: 'warning' as const },
    { label: t('center.stat.quarantined'), value: quarantineRows.length },
    { label: t('center.stat.protections'), value: protections.data?.total ?? 0 },
    { label: t('center.stat.reclaimable'), value: formatBytes(quarantineBytes) },
  ];

  return (
    <div className="space-y-6">
      <CleanupHeader title={t('center.title')} subtitle={t('center.subtitle')} />

      <Card>
        <CardContent className="flex items-start gap-3 py-4 text-sm text-muted-foreground">
          <Recycle className="mt-0.5 h-5 w-5 shrink-0 text-info" />
          <p className="max-w-3xl">{t('center.howItWorks')}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="py-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
              <div className={`mt-1 text-2xl font-semibold ${s.tone === 'warning' && Number(s.value) > 0 ? 'text-warning' : 'text-foreground'}`}>
                {s.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link key={tile.to} to={tile.to} className="group">
            <Card className="h-full transition-colors hover:border-info/50">
              <CardContent className="flex items-start gap-3 py-5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-info ring-1 ring-white/5">
                  <tile.icon className="h-5 w-5" />
                </div>
                <div className="space-y-0.5">
                  <div className="font-medium text-foreground group-hover:text-info">{tile.title}</div>
                  <div className="text-sm text-muted-foreground">{tile.desc}</div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
