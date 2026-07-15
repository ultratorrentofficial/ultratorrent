import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Save, Wifi } from 'lucide-react';
import { api, type SubtitleProviderCatalogEntry, type SubtitleProviderPatch } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

const REDACTED = '••••••••';

/** One provider's editable config row. */
function ProviderCard({ entry, canManage }: { entry: SubtitleProviderCatalogEntry; canManage: boolean }) {
  const { t } = useTranslation('subtitleIntelligence');
  const qc = useQueryClient();
  const toast = useToast();

  const [enabled, setEnabled] = useState(entry.config?.isEnabled ?? false);
  const [priority, setPriority] = useState(String(entry.config?.priority ?? 0));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of entry.fields) init[f] = String(entry.config?.config?.[f] ?? '');
    return init;
  });

  useEffect(() => {
    setEnabled(entry.config?.isEnabled ?? false);
    setPriority(String(entry.config?.priority ?? 0));
  }, [entry.config?.isEnabled, entry.config?.priority]);

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(secrets)) if (v !== '') config[k] = v;
      for (const [k, v] of Object.entries(fields)) config[k] = v; // non-secret, always sent
      const patch: SubtitleProviderPatch = { isEnabled: enabled, priority: Number(priority) || 0, config };
      return api.subtitles.upsertProvider(entry.key, patch);
    },
    onSuccess: () => {
      toast.success(t('providers.saved', { name: entry.label }));
      setSecrets({});
      void qc.invalidateQueries({ queryKey: ['subtitles', 'providers'] });
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  const test = useMutation({
    mutationFn: () => api.subtitles.testProvider(entry.key),
    onSuccess: (r) =>
      r.healthy ? toast.success(t('providers.healthy', { name: entry.label })) : toast.error(t('providers.unhealthy', { name: entry.label }), r.message),
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            <span className="font-medium">{entry.label}</span>
            {!entry.implemented && <Badge variant="outline">{t('providers.comingSoon')}</Badge>}
            {entry.config?.healthy === true && <Badge variant="success">{t('status.healthy')}</Badge>}
            {entry.config?.healthy === false && entry.config?.isEnabled && (
              <Badge variant="warning">{t('status.unknown')}</Badge>
            )}
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canManage || !entry.implemented} />
        </div>

        {entry.implemented && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {entry.secretFields.map((field) => (
                <div key={field}>
                  <Label htmlFor={`${entry.key}-${field}`}>{t(`providers.field.${field}`, { defaultValue: field })}</Label>
                  <Input
                    id={`${entry.key}-${field}`}
                    type="password"
                    autoComplete="off"
                    placeholder={entry.config?.config?.[field] ? REDACTED : ''}
                    value={secrets[field] ?? ''}
                    onChange={(e) => setSecrets((s) => ({ ...s, [field]: e.target.value }))}
                    disabled={!canManage}
                  />
                </div>
              ))}
              {entry.fields.map((field) => (
                <div key={field}>
                  <Label htmlFor={`${entry.key}-${field}`}>{t(`providers.field.${field}`, { defaultValue: field })}</Label>
                  <Input
                    id={`${entry.key}-${field}`}
                    value={fields[field] ?? ''}
                    onChange={(e) => setFields((s) => ({ ...s, [field]: e.target.value }))}
                    disabled={!canManage}
                  />
                </div>
              ))}
              <div>
                <Label htmlFor={`${entry.key}-priority`}>{t('providers.priority')}</Label>
                <Input
                  id={`${entry.key}-priority`}
                  type="number"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  disabled={!canManage}
                />
              </div>
            </div>

            {canManage && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
                  <Save className="mr-1 h-4 w-4" /> {t('common.save')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
                  <Wifi className="mr-1 h-4 w-4" /> {t('providers.test')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SubtitleProvidersPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_PROVIDERS);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['subtitles', 'providers'],
    queryFn: () => api.subtitles.listProviders(),
  });

  if (isLoading) return <CenteredSpinner label={t('common.loading')} />;
  if (isError || !data) return <ErrorState title={t('common.error')} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('providers.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('providers.subtitle')}</p>
      </div>
      <div className="grid gap-4">
        {data.map((entry) => (
          <ProviderCard key={entry.key} entry={entry} canManage={canManage} />
        ))}
      </div>
    </div>
  );
}
