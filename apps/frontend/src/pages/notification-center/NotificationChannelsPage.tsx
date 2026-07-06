import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Trash2, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const HEALTH_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  online: 'default', offline: 'destructive', degraded: 'secondary', unknown: 'outline',
};

export function NotificationChannelsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ['nc', 'channels'], queryFn: () => api.notificationCenter.channels() });
  const providers = useQuery({ queryKey: ['nc', 'providers'], queryFn: () => api.notificationCenter.providers() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'channels'] });

  const [form, setForm] = useState<{ name: string; provider: string; config: Record<string, unknown> }>({ name: '', provider: '', config: {} });
  const selected = providers.data?.find((p) => p.kind === form.provider);

  const create = useMutation({
    mutationFn: () => api.notificationCenter.createChannel({ name: form.name.trim() || selected?.name, provider: form.provider, isDefault: true, config: form.config }),
    onSuccess: () => { setForm({ name: '', provider: '', config: {} }); toast.success(t('channels.created')); invalidate(); },
    onError: (e) => toast.error(t('channels.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.notificationCenter.updateChannel(id, { enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteChannel(id), onSuccess: invalidate });
  const test = useMutation({
    mutationFn: (id: string) => api.notificationCenter.testChannel(id),
    onSuccess: (r) => (r.ok ? toast.success(t('channels.testOk')) : toast.error(t('channels.testFailed'), r.error)),
    onError: (e) => toast.error(t('channels.testFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (channels.isLoading) return <CenteredSpinner />;
  if (channels.isError) return <ErrorState title={t('channels.loadError')} onRetry={() => void channels.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('channels.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('channels.subtitle')}</p>
      </div>

      {(channels.data ?? []).map((c) => (
        <Card key={c.id}>
          <CardContent className="flex flex-wrap items-center gap-3 p-3">
            <Switch checked={c.enabled} onCheckedChange={(v) => toggle.mutate({ id: c.id, enabled: v })} />
            <span className="font-medium">{c.name}</span>
            <Badge variant="secondary">{c.provider}</Badge>
            <Badge variant={HEALTH_VARIANT[c.healthStatus] ?? 'outline'}>{t(`health.${c.healthStatus}`, { defaultValue: c.healthStatus })}</Badge>
            {c.isDefault && <Badge variant="outline">{t('channels.default')}</Badge>}
            <span className="text-xs text-muted-foreground">{t('channels.sentFailed', { sent: c.sentCount, failed: c.failedCount })}</span>
            <span className="flex-1" />
            <Button variant="secondary" size="sm" onClick={() => test.mutate(c.id)}><Zap className="h-3.5 w-3.5" />{t('channels.test')}</Button>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
          </CardContent>
        </Card>
      ))}
      {(channels.data ?? []).length === 0 && <EmptyState title={t('channels.empty')} />}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('channels.add')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="c-provider">{t('channels.provider')}</Label>
              <Select id="c-provider" value={form.provider} onChange={(e) => setForm({ name: form.name, provider: e.target.value, config: {} })}
                options={[{ value: '', label: t('channels.selectProvider') }, ...(providers.data ?? []).map((p) => ({ value: p.kind, label: p.name }))]} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-name">{t('channels.name')}</Label>
              <Input id="c-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={selected?.name} />
            </div>
            {selected?.configFields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`c-${field.key}`}>{field.label}{field.required ? ' *' : ''}</Label>
                {field.type === 'boolean' ? (
                  <div className="flex h-9 items-center"><Switch checked={Boolean(form.config[field.key])} onCheckedChange={(v) => setForm((f) => ({ ...f, config: { ...f.config, [field.key]: v } }))} /></div>
                ) : (
                  <Input id={`c-${field.key}`} type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'} placeholder={field.placeholder}
                    onChange={(e) => setForm((f) => ({ ...f, config: { ...f.config, [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value } }))} />
                )}
              </div>
            ))}
          </div>
          <Button onClick={() => create.mutate()} disabled={!form.provider || create.isPending}><Send className="h-3.5 w-3.5" />{t('channels.createBtn')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
