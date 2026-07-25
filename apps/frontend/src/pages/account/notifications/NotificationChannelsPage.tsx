import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Plus, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { api, type PersonalChannel, type PersonalChannelType } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const TYPES: PersonalChannelType[] = ['email', 'telegram', 'whatsapp', 'discord'];

/** Health → badge variant. Never the only signal: the label always accompanies it. */
const HEALTH_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  healthy: 'secondary', unverified: 'outline', degraded: 'outline',
  failing: 'destructive', disabled: 'outline',
};

/**
 * Personal notification connections — the destinations this user owns.
 *
 * Destinations are only ever shown masked; the raw address, phone or webhook URL is
 * encrypted server-side and is never returned by any endpoint, so there is nothing
 * here that could render it even by mistake.
 *
 * Telegram is created through a linking code rather than a form: a chat id typed into
 * a field could point at somebody else's chat, so the binding has to be proven by a
 * round trip through the bot.
 */
export function NotificationChannelsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();

  const [addType, setAddType] = useState<PersonalChannelType | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [linkCode, setLinkCode] = useState<{ code: string; expiresInSeconds: number } | null>(null);

  const channels = useQuery({
    queryKey: ['account', 'notifications', 'channels'],
    queryFn: () => api.account.notifications.channels(),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['account', 'notifications', 'channels'] });

  const create = useMutation({
    mutationFn: (v: { type: PersonalChannelType; name: string; config: Record<string, unknown> }) =>
      api.account.notifications.createChannel(v),
    onSuccess: () => { void invalidate(); closeAdd(); toast.success(t('myChannels.created')); },
    onError: (e: Error) => toast.error(translateError(e?.message)),
  });

  const startLink = useMutation({
    mutationFn: (n: string) => api.account.notifications.startTelegramLink(n),
    onSuccess: (r) => setLinkCode(r),
    onError: (e: Error) => toast.error(translateError(e?.message)),
  });

  const setEnabled = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.account.notifications.setChannelEnabled(v.id, v.enabled),
    onSuccess: () => void invalidate(),
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.account.notifications.makeChannelDefault(id),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.account.notifications.deleteChannel(id),
    onSuccess: (r) => {
      void invalidate();
      // Say what else changed: revoking a connection also drops the event routes
      // that pointed at it, and silently doing so would look like data loss.
      toast.success(r.routesRemoved
        ? t('myChannels.revokedWithRoutes', { count: r.routesRemoved })
        : t('myChannels.revoked'));
    },
  });

  /** Map a backend reason code onto a human sentence. */
  function translateError(reason?: string): string {
    const known = ['invalid_email', 'country_code_required', 'invalid_length', 'invalid_url',
      'https_required', 'host_not_allowed', 'not_a_webhook_path', 'link_required'];
    const key = known.find((k) => (reason ?? '').includes(k));
    return key
      ? t(`myChannels.error.${key}` as never, { defaultValue: t('myChannels.error.generic') })
      : (reason || t('myChannels.error.generic'));
  }

  function closeAdd() {
    setAddType(null); setName(''); setValue(''); setLinkCode(null);
  }

  function submitAdd() {
    if (!addType) return;
    if (addType === 'telegram') { startLink.mutate(name.trim() || 'Telegram'); return; }
    const configKey = addType === 'email' ? 'address' : addType === 'whatsapp' ? 'phone' : 'webhookUrl';
    create.mutate({ type: addType, name: name.trim() || addType, config: { [configKey]: value.trim() } });
  }

  if (channels.isLoading) return <CenteredSpinner />;
  if (channels.isError) {
    return <ErrorState title={t('myChannels.loadError')} onRetry={() => void channels.refetch()} />;
  }

  const all = channels.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('myChannels.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('myChannels.subtitle')}</p>
      </div>

      {TYPES.map((type) => {
        const list = all.filter((c) => c.type === type);
        return (
          <section key={type} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`matrix.channel.${type}`)}
              </h2>
              <Badge variant="outline">{t('myChannels.count', { count: list.length })}</Badge>
              <span className="flex-1" />
              <Button variant="secondary" size="sm" onClick={() => { closeAdd(); setAddType(type); }}>
                <Plus className="h-3.5 w-3.5" /> {t('myChannels.add')}
              </Button>
            </div>

            {list.length === 0 ? (
              <EmptyState title={t('myChannels.noneOfType')} />
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {list.map((c) => (
                  <ChannelCard
                    key={c.id}
                    channel={c}
                    onToggle={() => setEnabled.mutate({ id: c.id, enabled: !c.enabled })}
                    onDefault={() => makeDefault.mutate(c.id)}
                    onRemove={() => { if (confirm(t('myChannels.revokeConfirm', { name: c.name }))) remove.mutate(c.id); }}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      <Dialog
        open={addType !== null}
        onClose={closeAdd}
        title={addType ? t('myChannels.addTitle', { type: t(`matrix.channel.${addType}`) }) : ''}
      >
        {addType && (
          <div className="space-y-3">
            {linkCode ? (
              // Telegram: show the one-time code to send to the bot.
              <div className="space-y-2">
                <p className="text-sm">{t('myChannels.telegram.instructions')}</p>
                <p className="rounded-md border border-white/10 bg-black/20 p-3 text-center font-mono text-lg tracking-widest">
                  {linkCode.code}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('myChannels.telegram.expires', { minutes: Math.round(linkCode.expiresInSeconds / 60) })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { void invalidate(); closeAdd(); }}>
                    {t('myChannels.telegram.done')}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ch-name">{t('myChannels.name')}</Label>
                  <Input
                    id="ch-name" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder={t('myChannels.namePlaceholder')}
                  />
                </div>
                {addType !== 'telegram' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-value">{t(`myChannels.field.${addType}`)}</Label>
                    <Input
                      id="ch-value" value={value} onChange={(e) => setValue(e.target.value)}
                      placeholder={t(`myChannels.placeholder.${addType}`)}
                    />
                    <p className="text-xs text-muted-foreground">{t(`myChannels.hint.${addType}`)}</p>
                  </div>
                )}
                {addType === 'telegram' && (
                  <p className="text-sm text-muted-foreground">{t('myChannels.telegram.why')}</p>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={closeAdd}>{t('myChannels.cancel')}</Button>
                  <Button
                    size="sm"
                    disabled={create.isPending || startLink.isPending || (addType !== 'telegram' && !value.trim())}
                    onClick={submitAdd}
                  >
                    {addType === 'telegram' ? t('myChannels.telegram.start') : t('myChannels.save')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

function ChannelCard({
  channel: c, onToggle, onDefault, onRemove,
}: {
  channel: PersonalChannel;
  onToggle: () => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('notificationCenter');
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.name}</span>
          {c.isDefault && (
            <Badge variant="secondary" title={t('myChannels.defaultHint')}>
              <Star className="h-3 w-3" /> {t('myChannels.default')}
            </Badge>
          )}
          {/* Health carries an icon and a word, never colour alone. */}
          <Badge variant={HEALTH_VARIANT[c.health] ?? 'outline'}>
            {c.health === 'healthy' ? <Check className="h-3 w-3" />
              : c.health === 'failing' ? <AlertTriangle className="h-3 w-3" />
              : c.verified ? <ShieldCheck className="h-3 w-3" /> : null}
            {t(`myChannels.health.${c.health}`)}
          </Badge>
        </div>

        <p className="font-mono text-xs text-muted-foreground">{c.destinationMask ?? '•••'}</p>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <dt>{t('myChannels.verified')}</dt>
          <dd>{c.verified ? t('myChannels.yes') : t('myChannels.notYet')}</dd>
          <dt>{t('myChannels.lastSuccess')}</dt>
          <dd>{c.lastSuccessAt ? new Date(c.lastSuccessAt).toLocaleString() : '—'}</dd>
          {c.consecutiveFailures > 0 && (
            <>
              <dt>{t('myChannels.failures')}</dt>
              <dd>{c.consecutiveFailures}</dd>
            </>
          )}
        </dl>

        {!c.verified && (
          <p className="text-[11px] text-warning">{t('myChannels.unverifiedWarning')}</p>
        )}

        <div className="flex flex-wrap gap-1.5 border-t border-white/5 pt-2">
          <Button variant="ghost" size="sm" onClick={onToggle}>
            {c.enabled ? t('myChannels.disable') : t('myChannels.enable')}
          </Button>
          {!c.isDefault && (
            <Button variant="ghost" size="sm" onClick={onDefault}>{t('myChannels.makeDefault')}</Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" /> {t('myChannels.revoke')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
