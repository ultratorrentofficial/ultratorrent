import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/**
 * SMTP / email configuration for Media Server Analytics newsletters. Lives on
 * the Settings page; keeps its own `mediaServerAnalytics` i18n namespace + API
 * calls so it's self-contained wherever it's rendered.
 */
export function EmailSettingsCard() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const q = useQuery({ queryKey: ['msa', 'email'], queryFn: () => api.mediaServerAnalytics.emailSettings() });
  const [form, setForm] = useState({ host: '', port: 587, secure: false, auth: true, user: '', password: '', fromName: '', fromAddress: '' });
  const [testTo, setTestTo] = useState('');
  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, host: q.data.host, port: q.data.port, secure: q.data.secure, auth: q.data.auth, user: q.data.user, fromName: q.data.fromName, fromAddress: q.data.fromAddress }));
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.mediaServerAnalytics.updateEmailSettings(form),
    onSuccess: () => toast.success(t('newsletter.email.saved')),
    onError: (e) => toast.error(t('newsletter.email.testFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const test = useMutation({
    mutationFn: () => api.mediaServerAnalytics.testEmail(testTo),
    onSuccess: () => toast.success(t('newsletter.email.tested')),
    onError: (e) => toast.error(t('newsletter.email.testFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Mail className="h-4 w-4" />{t('newsletter.email.title')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label htmlFor="e-host">{t('newsletter.email.host')}</Label><Input id="e-host" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="e-port">{t('newsletter.email.port')}</Label><Input id="e-port" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))} /></div>
          <div className="flex items-end gap-2"><Switch checked={form.secure} onCheckedChange={(v) => setForm((f) => ({ ...f, secure: v }))} /><span className="text-sm">{t('newsletter.email.secure')}</span></div>
          <div className="flex items-end gap-2 sm:col-span-3"><Switch checked={form.auth} onCheckedChange={(v) => setForm((f) => ({ ...f, auth: v }))} /><span className="text-sm">{t('newsletter.email.auth')}</span><span className="text-xs text-muted-foreground">{t('newsletter.email.authHint')}</span></div>
          {form.auth && (
            <>
              <div className="space-y-1.5"><Label htmlFor="e-user">{t('newsletter.email.user')}</Label><Input id="e-user" value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="e-pass">{t('newsletter.email.password')}</Label><Input id="e-pass" type="password" value={form.password} placeholder={q.data?.hasPassword ? '••••••••' : ''} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></div>
            </>
          )}
          <div className="space-y-1.5"><Label htmlFor="e-fn">{t('newsletter.email.fromName')}</Label><Input id="e-fn" value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="e-fa">{t('newsletter.email.fromAddress')}</Label><Input id="e-fa" value={form.fromAddress} onChange={(e) => setForm((f) => ({ ...f, fromAddress: e.target.value }))} placeholder="ultratorrent@example.com" /></div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{t('newsletter.email.save')}</Button>
          <Input className="w-56" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={t('newsletter.email.testRecipient')} />
          <Button variant="secondary" onClick={() => test.mutate()} disabled={!testTo.trim() || test.isPending}>{t('newsletter.email.test')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
