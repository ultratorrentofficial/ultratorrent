import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Mail, Play, Send, Trash2 } from 'lucide-react';
import { api, ApiError, type Newsletter, type NewsletterPreview } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

function EmailSettingsCard() {
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

export function NewslettersPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', frequency: 'weekly', recipients: '' });
  const [preview, setPreview] = useState<{ id: string; data: NewsletterPreview } | null>(null);
  const [testTo, setTestTo] = useState<Record<string, string>>({});

  const q = useQuery({ queryKey: ['msa', 'newsletters'], queryFn: () => api.mediaServerAnalytics.newsletters() });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['msa', 'newsletters'] });

  const create = useMutation({
    mutationFn: () => api.mediaServerAnalytics.createNewsletter({ name: form.name.trim(), frequency: form.frequency, recipientEmails: form.recipients.split(',').map((s) => s.trim()).filter(Boolean) } as Partial<Newsletter>),
    onSuccess: () => { setForm({ name: '', frequency: 'weekly', recipients: '' }); toast.success(t('newsletter.created')); invalidate(); },
  });
  const doPreview = useMutation({ mutationFn: (id: string) => api.mediaServerAnalytics.previewNewsletter(id) });
  const send = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.sendNewsletter(id),
    onSuccess: (r) => { toast.success(t('newsletter.sent', { sent: r.sent, failed: r.failed })); invalidate(); },
    onError: (e) => toast.error(t('newsletter.sendFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const testSend = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.mediaServerAnalytics.testSendNewsletter(id, to),
    onSuccess: () => toast.success(t('newsletter.testSent')),
    onError: (e) => toast.error(t('newsletter.sendFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.mediaServerAnalytics.deleteNewsletter(id), onSuccess: invalidate });

  const freqOptions = (['daily', 'weekly', 'monthly', 'manual'] as const).map((v) => ({ value: v, label: t(`newsletter.freq.${v}`) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('newsletter.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('newsletter.subtitle')}</p>
      </div>

      <EmailSettingsCard />

      {q.isLoading ? <CenteredSpinner /> : q.isError ? <ErrorState title={t('newsletter.loadError')} onRetry={() => void q.refetch()} /> : (
        <>
          {(q.data ?? []).map((n) => (
            <Card key={n.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <span className="font-medium">{n.name}</span>
                <Badge variant="secondary">{t(`newsletter.freq.${n.frequency}`, { defaultValue: n.frequency })}</Badge>
                <span className="text-xs text-muted-foreground">{n.recipientEmails.length} · {n.nextRunAt ? t('newsletter.nextRun', { date: formatDateTime(n.nextRunAt) }) : ''}</span>
                <span className="flex-1" />
                <Button variant="secondary" size="sm" onClick={() => doPreview.mutate(n.id, { onSuccess: (data) => setPreview({ id: n.id, data }) })}><Eye className="h-3.5 w-3.5" />{t('newsletter.preview')}</Button>
                <Input className="w-40" value={testTo[n.id] ?? ''} onChange={(e) => setTestTo((s) => ({ ...s, [n.id]: e.target.value }))} placeholder={t('newsletter.email.testRecipient')} />
                <Button variant="secondary" size="sm" onClick={() => testSend.mutate({ id: n.id, to: testTo[n.id] ?? '' })} disabled={!testTo[n.id]?.trim()}><Send className="h-3.5 w-3.5" />{t('newsletter.testSend')}</Button>
                <Button size="sm" onClick={() => send.mutate(n.id)} disabled={send.isPending}><Play className="h-3.5 w-3.5" />{t('newsletter.sendNow')}</Button>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(n.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </CardContent>
            </Card>
          ))}
          {(q.data ?? []).length === 0 && <EmptyState title={t('newsletter.empty')} />}

          <Card>
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('newsletter.add.title')}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5"><Label htmlFor="n-name">{t('newsletter.add.name')}</Label><Input id="n-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label htmlFor="n-freq">{t('newsletter.add.frequency')}</Label><Select id="n-freq" value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))} options={freqOptions} /></div>
                <div className="space-y-1.5"><Label htmlFor="n-rec">{t('newsletter.add.recipients')}</Label><Input id="n-rec" value={form.recipients} onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} /></div>
              </div>
              <Button onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>{t('newsletter.add.submit')}</Button>
            </CardContent>
          </Card>

          {preview && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h2 className="text-sm font-semibold">{t('newsletter.previewTitle', { subject: preview.data.subject })}</h2>
                <p className="text-xs text-muted-foreground">{t('newsletter.itemCount', { count: preview.data.count })}</p>
                <iframe title="newsletter-preview" srcDoc={preview.data.html} className="h-96 w-full rounded-md border border-white/10 bg-white" />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
