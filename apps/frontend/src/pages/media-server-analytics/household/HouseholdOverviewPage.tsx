import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Home, Users, AlertTriangle, ShieldAlert, Smartphone, Wifi, Gauge, HelpCircle } from 'lucide-react';
import { api, type HouseholdSettings } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { KpiTile } from '../analytics-widgets';

const LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export function HouseholdOverviewPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const overview = useQuery({ queryKey: ['household', 'overview'], queryFn: () => api.mediaServerAnalytics.household.overview() });
  const settings = useQuery({ queryKey: ['household', 'settings'], queryFn: () => api.mediaServerAnalytics.household.settings() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Home className="h-6 w-6" /> {t('household.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('household.subtitle')}</p>
      </div>

      {overview.isLoading ? <CenteredSpinner /> : overview.isError || !overview.data ? (
        <ErrorState title={t('household.loadError')} onRetry={() => void overview.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile icon={Users} value={String(overview.data.usersMonitored)} label={t('household.kpi.monitored')} tone="text-info" />
          <KpiTile icon={Home} value={String(overview.data.homesEstablished)} label={t('household.kpi.homes')} tone="text-success" />
          <KpiTile icon={AlertTriangle} value={String(overview.data.needingReview)} label={t('household.kpi.review')} tone="text-warning" />
          <KpiTile icon={ShieldAlert} value={String(overview.data.likelySharing)} label={t('household.kpi.likelySharing')} tone="text-destructive" />
          <KpiTile icon={Smartphone} value={String(overview.data.mobileNetworks)} label={t('household.kpi.mobile')} tone="text-info" />
          <KpiTile icon={Wifi} value={String(overview.data.newResidential)} label={t('household.kpi.newResidential')} tone="text-muted-foreground" />
          <KpiTile icon={ShieldAlert} value={String(overview.data.highRisk)} label={t('household.kpi.highRisk')} tone="text-destructive" />
          <KpiTile icon={HelpCircle} value={String(overview.data.unknownNetworks)} label={t('household.kpi.unknown')} tone="text-muted-foreground" />
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('household.advisoryNote')}</p>

      {settings.data && <SettingsCard initial={settings.data} />}
    </div>
  );
}

function SettingsCard({ initial }: { initial: HouseholdSettings }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const set = <K extends keyof HouseholdSettings>(k: K, v: HouseholdSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.mediaServerAnalytics.household.updateSettings(form),
    onSuccess: () => { toast.success(t('household.settings.saved')); void qc.invalidateQueries({ queryKey: ['household'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase text-muted-foreground"><Gauge className="h-4 w-4" /> {t('household.settings.title')}</h3>
        <label className="flex items-center justify-between gap-4">
          <span><span className="font-medium">{t('household.settings.enabled')}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t('household.settings.enabledHint')}</span></span>
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={t('household.settings.enabled')} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span><span className="font-medium">{t('household.settings.notify')}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t('household.settings.notifyHint')}</span></span>
          <Switch checked={form.notify} onCheckedChange={(v) => set('notify', v)} aria-label={t('household.settings.notify')} />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><Label>{t('household.settings.reviewLevel')}</Label>
            <Select className="mt-1" value={form.reviewLevel} onChange={(e) => set('reviewLevel', e.target.value as HouseholdSettings['reviewLevel'])}>
              {LEVELS.map((l) => <option key={l} value={l}>{t(`household.risk.${l}`)}</option>)}
            </Select></div>
          <div><Label>{t('household.settings.minDays')}</Label>
            <Input type="number" min={1} max={365} className="mt-1 w-24" value={form.minHomeDistinctDays} onChange={(e) => set('minHomeDistinctDays', Math.max(1, Number.parseInt(e.target.value, 10) || 1))} /></div>
          <div><Label>{t('household.settings.minAge')}</Label>
            <Input type="number" min={0} max={365} className="mt-1 w-24" value={form.minHomeAgeDays} onChange={(e) => set('minHomeAgeDays', Math.max(0, Number.parseInt(e.target.value, 10) || 0))} /></div>
        </div>
        <div className="flex justify-end"><Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t('household.settings.saving') : t('household.settings.save')}</Button></div>
      </CardContent>
    </Card>
  );
}
