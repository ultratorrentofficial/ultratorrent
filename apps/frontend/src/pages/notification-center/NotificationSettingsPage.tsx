import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

export function NotificationSettingsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const q = useQuery({ queryKey: ['nc', 'settings'], queryFn: () => api.notificationCenter.settings() });
  const [form, setForm] = useState({ brand: '', defaultLocale: 'en-US', logNotificationBodies: false, globalRateLimitPerMin: '' as number | '' });
  useEffect(() => {
    if (q.data) setForm({ brand: q.data.brand, defaultLocale: q.data.defaultLocale, logNotificationBodies: q.data.logNotificationBodies, globalRateLimitPerMin: q.data.globalRateLimitPerMin ?? '' });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.notificationCenter.updateSettings({ brand: form.brand, defaultLocale: form.defaultLocale, logNotificationBodies: form.logNotificationBodies, globalRateLimitPerMin: form.globalRateLimitPerMin === '' ? null : Number(form.globalRateLimitPerMin) }),
    onSuccess: () => toast.success(t('settings.saved')),
    onError: (e) => toast.error(t('settings.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError) return <ErrorState title={t('settings.loadError')} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.subtitle')}</p>
      </div>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="s-brand">{t('settings.brand')}</Label><Input id="s-brand" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="s-locale">{t('settings.defaultLocale')}</Label><Input id="s-locale" value={form.defaultLocale} onChange={(e) => setForm((f) => ({ ...f, defaultLocale: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="s-rate">{t('settings.globalRateLimit')}</Label><Input id="s-rate" type="number" min={0} value={form.globalRateLimitPerMin} onChange={(e) => setForm((f) => ({ ...f, globalRateLimitPerMin: e.target.value === '' ? '' : Number(e.target.value) }))} /></div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.logNotificationBodies} onCheckedChange={(v) => setForm((f) => ({ ...f, logNotificationBodies: v }))} />
            <span className="text-sm">{t('settings.logBodies')}</span>
            <span className="text-xs text-muted-foreground">{t('settings.logBodiesHint')}</span>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{t('settings.save')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
