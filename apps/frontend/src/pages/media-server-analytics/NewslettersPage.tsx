import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Play, Send, Trash2 } from 'lucide-react';
import { api, ApiError, type Newsletter, type NewsletterPreview } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** Content-type groups a newsletter can cover (mirrors backend NEWSLETTER_GROUPS keys). */
const CONTENT_GROUP_KEYS = ['tv', 'movie', 'music', 'documentary', 'other'] as const;

/**
 * Toggle chips for the content types a newsletter covers. An empty selection
 * means "all types" — the newsletter isn't scoped and every group is included.
 */
function ContentTypeToggle({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CONTENT_GROUP_KEYS.map((key) => {
        const active = value.length === 0 || value.includes(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggle(key)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? 'border-amber-400/50 bg-amber-400/15 text-amber-300'
                : 'border-white/10 text-muted-foreground hover:text-foreground'
            } ${value.length === 0 ? 'opacity-60' : ''}`}
          >
            {t(`newsletter.content.type.${key}`)}
          </button>
        );
      })}
      <span className="text-[11px] text-muted-foreground">{value.length === 0 ? t('newsletter.content.allHint') : ''}</span>
    </div>
  );
}

export function NewslettersPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', frequency: 'weekly', recipients: '', dateRangeMode: 'since_last_send', lastDays: 7, startDate: '', contentSections: [] as string[] });
  const [preview, setPreview] = useState<{ id: string; data: NewsletterPreview } | null>(null);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [testTo, setTestTo] = useState<Record<string, string>>({});

  const q = useQuery({ queryKey: ['msa', 'newsletters'], queryFn: () => api.mediaServerAnalytics.newsletters() });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['msa', 'newsletters'] });

  const create = useMutation({
    mutationFn: () => api.mediaServerAnalytics.createNewsletter({
      name: form.name.trim(),
      frequency: form.frequency,
      recipientEmails: form.recipients.split(',').map((s) => s.trim()).filter(Boolean),
      dateRangeMode: form.dateRangeMode,
      lastDays: form.lastDays,
      startDate: form.dateRangeMode === 'since_date' && form.startDate ? new Date(form.startDate).toISOString() : null,
      contentSections: form.contentSections,
    } as Partial<Newsletter>),
    onSuccess: () => { setForm({ name: '', frequency: 'weekly', recipients: '', dateRangeMode: 'since_last_send', lastDays: 7, startDate: '', contentSections: [] }); toast.success(t('newsletter.created')); invalidate(); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Newsletter> }) => api.mediaServerAnalytics.updateNewsletter(id, patch),
    onSuccess: invalidate,
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
  const windowOptions = (['since_last_send', 'last_days', 'since_date'] as const).map((v) => ({ value: v, label: t(`newsletter.window.${v}`) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('newsletter.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('newsletter.subtitle')}</p>
      </div>

      {q.isLoading ? <CenteredSpinner /> : q.isError ? <ErrorState title={t('newsletter.loadError')} onRetry={() => void q.refetch()} /> : (
        <>
          {(q.data ?? []).map((n) => (
            <Card key={n.id}>
              <CardContent className="flex flex-col gap-3 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{n.name}</span>
                  <Badge variant="secondary">{t(`newsletter.freq.${n.frequency}`, { defaultValue: n.frequency })}</Badge>
                  <span className="text-xs text-muted-foreground">{n.recipientEmails.length} · {n.nextRunAt ? t('newsletter.nextRun', { date: formatDateTime(n.nextRunAt) }) : ''}</span>
                  <span className="flex-1" />
                  <Button variant="secondary" size="sm" onClick={() => doPreview.mutate(n.id, { onSuccess: (data) => setPreview({ id: n.id, data }) })}><Eye className="h-3.5 w-3.5" />{t('newsletter.preview')}</Button>
                  <Input className="w-40" value={testTo[n.id] ?? ''} onChange={(e) => setTestTo((s) => ({ ...s, [n.id]: e.target.value }))} placeholder={t('newsletter.email.testRecipient')} />
                  <Button variant="secondary" size="sm" onClick={() => testSend.mutate({ id: n.id, to: testTo[n.id] ?? '' })} disabled={!testTo[n.id]?.trim()}><Send className="h-3.5 w-3.5" />{t('newsletter.testSend')}</Button>
                  <Button size="sm" onClick={() => send.mutate(n.id)} disabled={send.isPending}><Play className="h-3.5 w-3.5" />{t('newsletter.sendNow')}</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(n.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                {/* Content window (which additions to include) */}
                <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-2 text-xs">
                  <span className="text-muted-foreground">{t('newsletter.window.label')}</span>
                  <Select
                    className="h-8 w-44"
                    value={n.dateRangeMode}
                    onChange={(e) => update.mutate({ id: n.id, patch: { dateRangeMode: e.target.value } })}
                    options={windowOptions}
                  />
                  {n.dateRangeMode === 'last_days' && (
                    <Input
                      type="number" min={1} className="h-8 w-24" defaultValue={n.lastDays}
                      onBlur={(e) => update.mutate({ id: n.id, patch: { lastDays: Math.max(1, Number(e.target.value) || 7) } })}
                    />
                  )}
                  {n.dateRangeMode === 'since_date' && (
                    <Input
                      type="date" className="h-8 w-44" defaultValue={n.startDate ? n.startDate.slice(0, 10) : ''}
                      onChange={(e) => update.mutate({ id: n.id, patch: { startDate: e.target.value ? new Date(e.target.value).toISOString() : null } })}
                    />
                  )}
                </div>
                {/* Content types this newsletter covers (Tautulli-style per-type sections) */}
                <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-2 text-xs">
                  <span className="text-muted-foreground">{t('newsletter.content.label')}</span>
                  <ContentTypeToggle
                    value={n.contentSections ?? []}
                    onChange={(next) => update.mutate({ id: n.id, patch: { contentSections: next } })}
                  />
                </div>
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
                <div className="space-y-1.5"><Label htmlFor="n-window">{t('newsletter.window.label')}</Label><Select id="n-window" value={form.dateRangeMode} onChange={(e) => setForm((f) => ({ ...f, dateRangeMode: e.target.value }))} options={windowOptions} /></div>
                {form.dateRangeMode === 'last_days' && (
                  <div className="space-y-1.5"><Label htmlFor="n-days">{t('newsletter.window.days')}</Label><Input id="n-days" type="number" min={1} value={form.lastDays} onChange={(e) => setForm((f) => ({ ...f, lastDays: Math.max(1, Number(e.target.value) || 7) }))} /></div>
                )}
                {form.dateRangeMode === 'since_date' && (
                  <div className="space-y-1.5"><Label htmlFor="n-start">{t('newsletter.window.startDate')}</Label><Input id="n-start" type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} /></div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>{t('newsletter.content.label')}</Label>
                <ContentTypeToggle value={form.contentSections} onChange={(next) => setForm((f) => ({ ...f, contentSections: next }))} />
              </div>
              <Button onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>{t('newsletter.add.submit')}</Button>
            </CardContent>
          </Card>

          {preview && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold">{t('newsletter.previewTitle', { subject: preview.data.subject })}</h2>
                    <p className="text-xs text-muted-foreground">
                      {t('newsletter.itemCount', { count: preview.data.count })}
                      {preview.data.sample && <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">{t('newsletter.previewMode.sample')}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
                    {(['desktop', 'mobile'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPreviewMode(m)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${previewMode === m ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        {t(`newsletter.previewMode.${m}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-center rounded-md bg-black/20 p-3">
                  <iframe
                    title="newsletter-preview"
                    srcDoc={preview.data.html}
                    className="h-[32rem] rounded-md border border-white/10 bg-white transition-all"
                    style={{ width: previewMode === 'mobile' ? 390 : '100%', maxWidth: '100%' }}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
