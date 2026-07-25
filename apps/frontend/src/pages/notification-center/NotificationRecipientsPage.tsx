import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const EMPTY = { displayName: '', email: '', phone: '', telegramChatId: '', whatsappNumber: '' };

export function NotificationRecipientsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const recipients = useQuery({ queryKey: ['nc', 'recipients'], queryFn: () => api.notificationCenter.recipients() });
  const groups = useQuery({ queryKey: ['nc', 'groups'], queryFn: () => api.notificationCenter.groups() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'recipients'] });
  const [form, setForm] = useState({ ...EMPTY });

  const create = useMutation({
    mutationFn: () => api.notificationCenter.createRecipient(form),
    onSuccess: () => { setForm({ ...EMPTY }); toast.success(t('recipients.created')); invalidate(); },
    onError: (e) => toast.error(t('recipients.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteRecipient(id), onSuccess: invalidate });

  if (recipients.isLoading) return <CenteredSpinner />;
  if (recipients.isError) return <ErrorState title={t('recipients.loadError')} onRetry={() => void recipients.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('recipients.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('recipients.subtitle')}</p>
      </div>

      {(groups.data ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(groups.data ?? []).map((g) => (
            <Badge key={g.id} variant="secondary">{g.name} · {g.memberCount}</Badge>
          ))}
        </div>
      )}

      {(recipients.data ?? []).map((r) => (
        <Card key={r.id}>
          <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="font-medium">{r.displayName}</span>
            {/* Where this recipient comes from. A user-derived row is kept in step with
                its account (name, email, active state), so editing or deleting it here
                would be undone by the next sync — the badge is what makes that visible
                rather than surprising. */}
            <Badge variant={r.userId ? 'secondary' : 'outline'}>
              {r.userId ? t('recipients.fromUser') : t('recipients.external')}
            </Badge>
            {!r.enabled && <Badge variant="destructive">{t('recipients.disabled')}</Badge>}
            {r.email && <span className="text-xs text-muted-foreground">{r.email}</span>}
            {r.phone && <span className="text-xs text-muted-foreground">{r.phone}</span>}
            {r.telegramChatId && <Badge variant="outline">Telegram</Badge>}
            {r.whatsappNumber && <Badge variant="outline">WhatsApp</Badge>}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={!!r.userId}
              title={r.userId ? t('recipients.userManaged') : undefined}
              onClick={() => remove.mutate(r.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      ))}
      {(recipients.data ?? []).length === 0 && <EmptyState title={t('recipients.empty')} />}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('recipients.add')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="r-name">{t('recipients.displayName')}</Label><Input id="r-name" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="r-email">{t('recipients.email')}</Label><Input id="r-email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="r-phone">{t('recipients.phone')}</Label><Input id="r-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+15551234567" /></div>
            <div className="space-y-1.5"><Label htmlFor="r-tg">{t('recipients.telegram')}</Label><Input id="r-tg" value={form.telegramChatId} onChange={(e) => setForm((f) => ({ ...f, telegramChatId: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="r-wa">{t('recipients.whatsapp')}</Label><Input id="r-wa" value={form.whatsappNumber} onChange={(e) => setForm((f) => ({ ...f, whatsappNumber: e.target.value }))} placeholder="+15551234567" /></div>
          </div>
          <Button onClick={() => create.mutate()} disabled={!form.displayName.trim() || create.isPending}><UserPlus className="h-3.5 w-3.5" />{t('recipients.createBtn')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
