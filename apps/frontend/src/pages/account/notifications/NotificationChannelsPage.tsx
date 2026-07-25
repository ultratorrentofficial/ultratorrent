import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Hash, Mail, MessageCircle, Send, Unplug } from 'lucide-react';
import { api, type NotificationChannelDto } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

const ICONS = { email: Mail, telegram: MessageCircle, discord: Hash } as const;

const HEALTH_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  healthy: 'default',
  unverified: 'outline',
  failing: 'destructive',
  disabled: 'secondary',
};

/**
 * Where notifications arrive.
 *
 * One card per channel, one active connection each. No multi-destination
 * picker, no per-event routing — those questions belong to the Events table, and
 * splitting them across two screens is what made the old system unexplainable.
 *
 * A destination is never displayed: the server returns a mask, and there is no
 * endpoint that could return the real address.
 */
export function NotificationChannelsPage() {
  const { t } = useTranslation('notifications');
  const toast = useToast();
  const qc = useQueryClient();
  const [address, setAddress] = useState('');
  const [telegramCode, setTelegramCode] = useState<{ code: string; botUsername: string; expiresInSeconds: number } | null>(null);

  const channels = useQuery({
    queryKey: ['account', 'notifications', 'channels'],
    queryFn: () => api.account.notifications.channels(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['account', 'notifications', 'channels'] });

  const connect = useMutation({
    mutationFn: (value: string) => api.account.notifications.connectEmail(value),
    onSuccess: () => {
      setAddress('');
      invalidate();
      toast.success(t('channels.connected'));
    },
    // The server's message is the useful one — "connection refused" tells an
    // operator far more than a generic failure would.
    onError: (e: Error) => toast.error(e?.message || t('channels.connectFailed')),
  });

  const test = useMutation({
    mutationFn: (type: string) => api.account.notifications.testChannel(type),
    onSuccess: () => { invalidate(); toast.success(t('channels.testSent')); },
    onError: (e: Error) => toast.error(e?.message || t('channels.testFailed')),
  });

  const startTelegram = useMutation({
    mutationFn: () => api.account.notifications.linkTelegram(),
    onSuccess: (link) => setTelegramCode(link),
    onError: (e: Error) => toast.error(e?.message || t('channels.connectFailed')),
  });

  const confirmTelegram = useMutation({
    mutationFn: () => api.account.notifications.confirmTelegram(),
    onSuccess: () => {
      setTelegramCode(null);
      invalidate();
      toast.success(t('channels.connected'));
    },
    // Not-yet-received is the common case, not an error state — the user simply
    // has not sent it yet, so the message says what to do next.
    onError: (e: Error) => toast.error(e?.message || t('channels.telegramNotReceived')),
  });

  const disconnect = useMutation({
    mutationFn: (type: string) => api.account.notifications.disconnectChannel(type),
    onSuccess: () => { invalidate(); toast.success(t('channels.disconnected')); },
    onError: (e: Error) => toast.error(e?.message || t('channels.disconnectFailed')),
  });

  if (channels.isLoading) return <CenteredSpinner />;
  if (channels.isError) {
    return <ErrorState title={t('channels.loadError')} onRetry={() => void channels.refetch()} />;
  }

  const { channels: list, platformEmailReady, telegram } = channels.data!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('channels.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('channels.subtitle')}</p>
      </div>

      {!platformEmailReady && (
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            {/* Says WHY rather than letting the user discover it at test time. */}
            <p className="text-sm text-muted-foreground">{t('channels.smtpNotConfigured')}</p>
          </CardContent>
        </Card>
      )}

      {list.map((channel: NotificationChannelDto) => {
        const Icon = ICONS[channel.type];
        const available = channel.type === 'email' || channel.type === 'telegram';
        return (
          <Card key={channel.type}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{t(`channels.${channel.type}`)}</span>
                <Badge variant={HEALTH_VARIANT[channel.health] ?? 'outline'}>
                  {t(`channels.health.${channel.health}`, { defaultValue: channel.health })}
                </Badge>
                {channel.connected && channel.maskedDestination && (
                  <span className="text-sm text-muted-foreground">{channel.maskedDestination}</span>
                )}
                <span className="flex-1" />
                {channel.connected && channel.verified && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label={t('channels.health.healthy')} />
                )}
              </div>

              {!available ? (
                <p className="text-sm text-muted-foreground">{t('channels.comingSoon')}</p>
              ) : channel.type === 'telegram' && !channel.connected ? (
                !telegram.configured ? (
                  <p className="text-sm text-muted-foreground">{t('channels.telegramNotConfigured')}</p>
                ) : telegramCode ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {t('channels.telegramStep1', { bot: `@${telegramCode.botUsername}` })}
                    </p>
                    {/* Selectable, because the whole flow is "copy this there". */}
                    <p className="select-all rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-center font-mono text-2xl tracking-[0.3em]">
                      {telegramCode.code}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('channels.telegramExpires', { minutes: Math.round(telegramCode.expiresInSeconds / 60) })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => confirmTelegram.mutate()} disabled={confirmTelegram.isPending}>
                        {t('channels.telegramConfirm')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setTelegramCode(null)}>
                        {t('channels.telegramCancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" onClick={() => startTelegram.mutate()} disabled={startTelegram.isPending}>
                    {t('channels.telegramConnect')}
                  </Button>
                )
              ) : channel.connected ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => test.mutate(channel.type)}
                    disabled={test.isPending}
                  >
                    <Send className="h-3.5 w-3.5" /> {t('channels.sendTest')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => disconnect.mutate(channel.type)}
                    disabled={disconnect.isPending}
                  >
                    <Unplug className="h-3.5 w-3.5" /> {t('channels.disconnect')}
                  </Button>
                </div>
              ) : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => { e.preventDefault(); connect.mutate(address); }}
                >
                  <div className="min-w-[16rem] flex-1 space-y-1.5">
                    <Label htmlFor="notif-email">{t('channels.emailAddress')}</Label>
                    <Input
                      id="notif-email"
                      type="email"
                      value={address}
                      placeholder="you@example.com"
                      onChange={(e) => setAddress(e.target.value)}
                      disabled={!platformEmailReady}
                    />
                  </div>
                  <Button type="submit" disabled={!platformEmailReady || connect.isPending || !address.trim()}>
                    {t('channels.connect')}
                  </Button>
                </form>
              )}

              {channel.lastError && (
                <p className="text-xs text-destructive">{channel.lastError}</p>
              )}
              {channel.connected && !channel.verified && (
                // Verification is what makes a connection deliverable, so an
                // unverified one must not look finished.
                <p className="text-xs text-muted-foreground">{t('channels.unverifiedHint')}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
