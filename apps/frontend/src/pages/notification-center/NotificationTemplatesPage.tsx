import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Trash2 } from 'lucide-react';
import { api, ApiError, type NotificationRenderedMessage } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const EMPTY = { name: '', event: '', subject: '', title: '', text: '', sms: '', telegram: '' };
const KINDS = ['email', 'sms', 'telegram', 'whatsapp'];

export function NotificationTemplatesPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nc', 'templates'], queryFn: () => api.notificationCenter.templates() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'templates'] });
  const [form, setForm] = useState({ ...EMPTY });
  const [kind, setKind] = useState('email');
  const [preview, setPreview] = useState<NotificationRenderedMessage | null>(null);

  const create = useMutation({
    mutationFn: () => api.notificationCenter.createTemplate(form),
    onSuccess: () => { setForm({ ...EMPTY }); toast.success(t('templates.created')); invalidate(); },
    onError: (e) => toast.error(t('templates.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteTemplate(id), onSuccess: invalidate });
  const doPreview = useMutation({
    mutationFn: () => api.notificationCenter.previewTemplate({ body: form, kind }),
    onSuccess: (r) => setPreview(r),
  });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError) return <ErrorState title={t('templates.loadError')} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('templates.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('templates.subtitle')}</p>
      </div>

      {(q.data ?? []).map((tpl) => (
        <Card key={tpl.id}>
          <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="font-medium">{tpl.name}</span>
            {tpl.event && <code className="text-xs text-muted-foreground">{tpl.event}</code>}
            {tpl.system && <Badge variant="outline">{t('templates.system')}</Badge>}
            <span className="flex-1" />
            {!tpl.system && <Button variant="ghost" size="sm" onClick={() => remove.mutate(tpl.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
          </CardContent>
        </Card>
      ))}
      {(q.data ?? []).length === 0 && <EmptyState title={t('templates.empty')} />}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('templates.add')}</h2>
          <p className="text-xs text-muted-foreground">{t('templates.varsHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="t-name">{t('templates.name')}</Label><Input id="t-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="t-event">{t('templates.event')}</Label><Input id="t-event" value={form.event} onChange={(e) => setForm((f) => ({ ...f, event: e.target.value }))} placeholder="media_server.user_started_watching" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="t-subject">{t('templates.subject')}</Label><Input id="t-subject" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="{{userDisplayName}} started watching {{mediaTitle}}" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="t-text">{t('templates.text')}</Label><Input id="t-text" value={form.text} onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="t-sms">{t('templates.sms')}</Label><Input id="t-sms" value={form.sms} onChange={(e) => setForm((f) => ({ ...f, sms: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="t-tg">{t('templates.telegram')}</Label><Input id="t-tg" value={form.telegram} onChange={(e) => setForm((f) => ({ ...f, telegram: e.target.value }))} /></div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>{t('templates.createBtn')}</Button>
            <Select className="h-9 w-32" value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS.map((k) => ({ value: k, label: k }))} />
            <Button variant="secondary" onClick={() => doPreview.mutate()}><Eye className="h-3.5 w-3.5" />{t('templates.preview')}</Button>
          </div>
          {preview && (
            <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm">
              {preview.subject && <div className="font-semibold">{preview.subject}</div>}
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{preview.markdown || preview.text}</pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
