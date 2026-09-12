import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { api, type StreamControlSettings, type StreamEnforcementAction, type StreamEnforcementScope } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

const ACTIONS: StreamEnforcementAction[] = ['terminate_newest', 'terminate_oldest', 'warn', 'log'];
const SCOPES: StreamEnforcementScope[] = ['all_servers', 'per_server'];

/**
 * Global Stream Control — the master switch and the defaults every user inherits.
 * Enforcement is off until an administrator turns it on here (spec §3).
 */
export function StreamControlSettingsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['streamControl', 'settings'], queryFn: () => api.mediaServerAnalytics.streamControl.settings() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="h-6 w-6" /> {t('streamControl.settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('streamControl.settings.subtitle')}</p>
      </div>
      {settings.isLoading ? (
        <CenteredSpinner />
      ) : settings.isError || !settings.data ? (
        <ErrorState title={t('streamControl.settings.loadError')} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsForm
          initial={settings.data}
          onSaved={() => {
            toast.success(t('streamControl.settings.saved'));
            void qc.invalidateQueries({ queryKey: ['streamControl'] });
            void qc.invalidateQueries({ queryKey: ['mediaServerAnalytics', 'streamStatus'] });
          }}
          onError={(m) => toast.error(m)}
        />
      )}
    </div>
  );
}

function SettingsForm({ initial, onSaved, onError }: { initial: StreamControlSettings; onSaved: () => void; onError: (m: string) => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const [form, setForm] = useState(initial);
  const [limited, setLimited] = useState(initial.defaultLimit != null);
  useEffect(() => { setForm(initial); setLimited(initial.defaultLimit != null); }, [initial]);

  const save = useMutation({
    mutationFn: () => api.mediaServerAnalytics.streamControl.updateSettings({ ...form, defaultLimit: limited ? (form.defaultLimit ?? 1) : null }),
    onSuccess: onSaved,
    onError: (e: Error) => onError(e.message),
  });

  const set = <K extends keyof StreamControlSettings>(k: K, v: StreamControlSettings[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="font-medium">{t('streamControl.settings.enable')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('streamControl.settings.enableHint')}</span>
          </span>
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={t('streamControl.settings.enable')} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>{t('streamControl.settings.defaultLimit')}</Label>
            <div className="mt-1 flex items-center gap-2">
              <Select value={limited ? 'custom' : 'unlimited'} onChange={(e) => setLimited(e.target.value === 'custom')}>
                <option value="unlimited">{t('streamControl.limit.unlimited')}</option>
                <option value="custom">{t('streamControl.limit.custom')}</option>
              </Select>
              {limited && (
                <Input
                  type="number" min={1} max={100} className="w-24"
                  value={form.defaultLimit ?? 1}
                  onChange={(e) => set('defaultLimit', Math.max(1, Math.min(100, Number.parseInt(e.target.value, 10) || 1)))}
                />
              )}
            </div>
          </div>

          <div>
            <Label>{t('streamControl.settings.defaultAction')}</Label>
            <Select className="mt-1" value={form.defaultAction} onChange={(e) => set('defaultAction', e.target.value as StreamEnforcementAction)}>
              {ACTIONS.map((a) => <option key={a} value={a}>{t(`streamControl.action.${a}`)}</option>)}
            </Select>
          </div>

          <div>
            <Label>{t('streamControl.settings.scope')}</Label>
            <Select className="mt-1" value={form.scope} onChange={(e) => set('scope', e.target.value as StreamEnforcementScope)}>
              {SCOPES.map((s) => <option key={s} value={s}>{t(`streamControl.scope.${s}`)}</option>)}
            </Select>
          </div>

          <div>
            <Label>{t('streamControl.settings.grace')}</Label>
            <Input
              type="number" min={0} max={300} className="mt-1 w-28"
              value={form.gracePeriodSeconds}
              onChange={(e) => set('gracePeriodSeconds', Math.max(0, Math.min(300, Number.parseInt(e.target.value, 10) || 0)))}
            />
          </div>

          <div>
            <Label>{t('streamControl.settings.pausedExpiration')}</Label>
            <Input
              type="number" min={0} max={1440} className="mt-1 w-28"
              value={form.pausedExpirationMinutes}
              onChange={(e) => set('pausedExpirationMinutes', Math.max(0, Math.min(1440, Number.parseInt(e.target.value, 10) || 0)))}
            />
          </div>
        </div>

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="font-medium">{t('streamControl.settings.countPaused')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('streamControl.settings.countPausedHint')}</span>
          </span>
          <Switch checked={form.countPaused} onCheckedChange={(v) => set('countPaused', v)} aria-label={t('streamControl.settings.countPaused')} />
        </label>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('streamControl.settings.saving') : t('streamControl.settings.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
