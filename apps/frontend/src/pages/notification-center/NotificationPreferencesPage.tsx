import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** Per-recipient opt-outs: a preference row with enabled=false suppresses an event/channel. */
export function NotificationPreferencesPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const recipients = useQuery({ queryKey: ['nc', 'recipients'], queryFn: () => api.notificationCenter.recipients() });
  const [recipientId, setRecipientId] = useState('');
  const [event, setEvent] = useState('');
  const prefs = useQuery({ queryKey: ['nc', 'prefs', recipientId], queryFn: () => api.notificationCenter.preferences(recipientId), enabled: !!recipientId });

  const set = useMutation({
    mutationFn: (body: { event: string; enabled: boolean }) => api.notificationCenter.setPreference({ recipientId, event: body.event, channel: null, enabled: body.enabled }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['nc', 'prefs', recipientId] }); toast.success(t('preferences.saved')); },
  });

  if (recipients.isLoading) return <CenteredSpinner />;
  if (recipients.isError) return <ErrorState title={t('preferences.loadError')} onRetry={() => void recipients.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('preferences.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('preferences.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="space-y-1.5 sm:max-w-sm">
            <Label htmlFor="p-recipient">{t('preferences.recipient')}</Label>
            <Select id="p-recipient" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
              options={[{ value: '', label: t('preferences.selectRecipient') }, ...(recipients.data ?? []).map((r) => ({ value: r.id, label: r.displayName }))]} />
          </div>

          {recipientId && (
            <>
              {(prefs.data ?? []).length === 0 ? (
                <EmptyState title={t('preferences.none')} />
              ) : (
                <div className="space-y-1">
                  {(prefs.data ?? []).map((p) => (
                    <div key={p.id} className="flex items-center gap-3 border-t border-white/5 py-1.5 text-sm first:border-0">
                      <Switch checked={p.enabled} onCheckedChange={(v) => set.mutate({ event: p.event, enabled: v })} />
                      <code className="text-xs">{p.event === '*' ? t('preferences.allEvents') : p.event}</code>
                      {p.channel && <span className="text-xs text-muted-foreground">· {p.channel}</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2 border-t border-white/5 pt-3">
                <div className="space-y-1.5"><Label htmlFor="p-event">{t('preferences.event')}</Label><Input id="p-event" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="media_server.user_started_watching" /></div>
                <Button variant="secondary" onClick={() => { if (event.trim()) { set.mutate({ event: event.trim(), enabled: false }); setEvent(''); } }}>{t('preferences.addOptOut')}</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
