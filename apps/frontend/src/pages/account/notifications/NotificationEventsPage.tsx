import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Mail, MessageCircle, Hash } from 'lucide-react';
import { api, type NotificationEventRowDto } from '@/lib/api';
import type { NotificationChannelType } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** The four columns, in the order the table reads left to right. */
const CHANNELS: Array<{ type: NotificationChannelType; icon: typeof Bell }> = [
  { type: 'in_app', icon: Bell },
  { type: 'email', icon: Mail },
  { type: 'telegram', icon: MessageCircle },
  { type: 'discord', icon: Hash },
];

/** Maps a channel to the preference flag it controls. */
const FLAG: Record<NotificationChannelType, keyof NotificationEventRowDto['preference']> = {
  in_app: 'inAppEnabled',
  email: 'emailEnabled',
  telegram: 'telegramEnabled',
  discord: 'discordEnabled',
};

/**
 * The Events table — the whole of "which events do I want, and where".
 *
 * Deliberately one row per event with four switches. There is no rule builder,
 * no routing precedence and no per-row destination picker, because those are
 * what made the previous system impossible to reason about. A user answers two
 * questions here and nothing else.
 *
 * External channels are shown but disabled until Phase 4-6 connect them; a
 * switch that cannot deliver is worse than a visibly unavailable one.
 */
export function NotificationEventsPage() {
  const { t } = useTranslation('notifications');
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const prefs = useQuery({
    queryKey: ['account', 'notifications', 'preferences'],
    queryFn: () => api.account.notifications.preferences(),
  });

  const update = useMutation({
    mutationFn: ({ eventKey, patch }: { eventKey: string; patch: Record<string, boolean> }) =>
      api.account.notifications.updatePreference(eventKey, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', 'notifications', 'preferences'] }),
    onError: (e: Error) => toast.error(e?.message || t('events.saveFailed')),
  });

  const rows = prefs.data?.rows ?? [];

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.definition.category))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (category && row.definition.category !== category) return false;
      if (!term) return true;
      const label = t(row.definition.titleKey, { defaultValue: row.definition.key }).toLowerCase();
      return label.includes(term) || row.definition.key.toLowerCase().includes(term);
    });
  }, [rows, search, category, t]);

  if (prefs.isLoading) return <CenteredSpinner />;
  if (prefs.isError) {
    return <ErrorState title={t('events.loadError')} onRetry={() => void prefs.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('events.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('events.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <Input
            className="sm:max-w-xs"
            placeholder={t('events.searchPlaceholder')}
            aria-label={t('events.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            className="w-48"
            aria-label={t('events.category')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[
              { value: '', label: t('events.allCategories') },
              ...categories.map((c) => ({ value: c, label: t(`categories.${c}`, { defaultValue: c }) })),
            ]}
          />
        </CardContent>
      </Card>

      {visible.length === 0 ? (
        <EmptyState title={t('events.empty')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('events.event')}</TableHead>
                  {CHANNELS.map(({ type, icon: Icon }) => (
                    <TableHead key={type} className="w-28 text-center">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {t(`channels.${type}`)}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const label = t(row.definition.titleKey, { defaultValue: row.definition.key });
                  return (
                    <TableRow key={row.definition.key}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="font-medium">{label}</p>
                          <p className="text-xs text-muted-foreground">
                            {t(row.definition.descriptionKey, { defaultValue: '' })}
                          </p>
                        </div>
                      </TableCell>
                      {CHANNELS.map(({ type }) => {
                        const flag = FLAG[type];
                        const on = Boolean(row.preference[flag]);
                        // Only in-app can deliver today. A switch the platform
                        // cannot honour would promise delivery that never comes.
                        const available = type === 'in_app';
                        return (
                          <TableCell key={type} className="text-center">
                            <Switch
                              checked={on && row.preference.enabled}
                              disabled={!available || update.isPending}
                              aria-label={`${label} — ${t(`channels.${type}`)}`}
                              onCheckedChange={(v: boolean) =>
                                update.mutate({
                                  eventKey: row.definition.key,
                                  // Turning any channel on implies wanting the
                                  // event: a row with every channel off but
                                  // `enabled: true` is a state nobody chose.
                                  patch: v ? { [flag]: true, enabled: true } : { [flag]: false },
                                })
                              }
                            />
                            {!available && (
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                {t('events.notConnected')}
                              </p>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
