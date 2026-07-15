import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Captions, Download, Info, Languages, Save, Settings2, Wand2 } from 'lucide-react';
import { api, type SubtitleGlobalSettings } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

const INTERVAL_PRESETS = [0, 360, 720, 1440, 10080]; // off, 6h, 12h, daily, weekly

/** A labelled control row with a helper description underneath. */
function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SubtitleSettingsPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_SETTINGS);

  const settings = useQuery({ queryKey: ['subtitles', 'settings'], queryFn: () => api.subtitles.getSettings() });
  const caps = useQuery({ queryKey: ['subtitles', 'sync-caps'], queryFn: () => api.subtitles.syncCapabilities() });

  const [form, setForm] = useState<SubtitleGlobalSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.subtitles.updateSettings(form ?? {}),
    onSuccess: () => {
      toast.success(t('settings.saved'));
      void qc.invalidateQueries({ queryKey: ['subtitles', 'settings'] });
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  if (settings.isLoading || !form) return <CenteredSpinner label={t('common.loading')} />;
  if (settings.isError) return <ErrorState title={t('common.error')} onRetry={() => settings.refetch()} />;

  const ffAvailable = caps.data?.ffsubsync.available ?? false;
  const set = <K extends keyof SubtitleGlobalSettings>(k: K, v: SubtitleGlobalSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Settings2 className="h-6 w-6 text-primary" /> {t('settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.subtitle')}</p>
      </div>

      {/* --- Automation controls --- */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('settings.automation.heading')}
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">{t('settings.automation.intro')}</p>

          <Field label={t('settings.interval.label')} help={t('settings.interval.help')}>
            <Select
              value={String(INTERVAL_PRESETS.includes(form.autoScanIntervalMinutes) ? form.autoScanIntervalMinutes : 0)}
              onChange={(e) => set('autoScanIntervalMinutes', Number(e.target.value))}
              disabled={!canEdit}
              options={INTERVAL_PRESETS.map((m) => ({ value: String(m), label: t(`settings.interval.opt.${m}`, { defaultValue: String(m) }) }))}
            />
          </Field>

          <Field label={t('settings.autoDownload.label')} help={t('settings.autoDownload.help')}>
            <Switch checked={form.autoDownload} onCheckedChange={(v) => set('autoDownload', v)} disabled={!canEdit} />
          </Field>

          <Field
            label={t('settings.autoSync.label')}
            help={ffAvailable ? t('settings.autoSync.help') : t('settings.autoSync.unavailable')}
          >
            <Switch checked={form.autoSync} onCheckedChange={(v) => set('autoSync', v)} disabled={!canEdit || !ffAvailable} />
          </Field>

          <Field label={t('settings.defaultLanguages.label')} help={t('settings.defaultLanguages.help')}>
            <Input
              className="w-40"
              value={form.defaultLanguages.join(', ')}
              onChange={(e) => set('defaultLanguages', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
              placeholder="en, es"
              disabled={!canEdit}
            />
          </Field>

          {canEdit && (
            <div className="mt-3">
              <Button onClick={() => save.mutate()} loading={save.isPending}>
                <Save className="mr-1 h-4 w-4" /> {t('common.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- Explainer: how it all works --- */}
      <Card>
        <CardContent className="space-y-5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Info className="h-4 w-4" /> {t('settings.explain.heading')}
          </h2>

          <section>
            <h3 className="flex items-center gap-2 font-medium"><Captions className="h-4 w-4 text-primary" />{t('settings.explain.pipeline.heading')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.explain.pipeline.body')}</p>
          </section>

          <section>
            <h3 className="flex items-center gap-2 font-medium"><Download className="h-4 w-4 text-primary" />{t('settings.explain.providers.heading')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.explain.providers.body')}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/subtitles/providers')}>
              {t('settings.explain.providers.link')}
            </Button>
          </section>

          <section>
            <h3 className="font-medium">{t('settings.explain.scoring.heading')}</h3>
            <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
              <li><Badge variant="success">90–100</Badge> {t('settings.explain.scoring.auto')}</li>
              <li><Badge variant="info">75–89</Badge> {t('settings.explain.scoring.download')}</li>
              <li><Badge variant="warning">50–74</Badge> {t('settings.explain.scoring.present')}</li>
              <li><Badge variant="destructive">&lt;50</Badge> {t('settings.explain.scoring.reject')}</li>
            </ul>
          </section>

          <section>
            <h3 className="flex items-center gap-2 font-medium"><Languages className="h-4 w-4 text-primary" />{t('settings.explain.languages.heading')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.explain.languages.body')}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/subtitles/languages')}>
              {t('settings.explain.languages.link')}
            </Button>
          </section>

          <section>
            <h3 className="flex items-center gap-2 font-medium">
              <AudioLines className="h-4 w-4 text-primary" />{t('settings.explain.sync.heading')}
              <Badge variant={ffAvailable ? 'success' : 'outline'}>
                {ffAvailable ? `FFsubsync ${caps.data?.ffsubsync.version ?? ''}`.trim() : t('settings.explain.sync.ffUnavailable')}
              </Badge>
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.explain.sync.body')}</p>
            {!ffAvailable && (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Wand2 className="h-3 w-3" />{t('settings.explain.sync.ffHint')}</p>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
