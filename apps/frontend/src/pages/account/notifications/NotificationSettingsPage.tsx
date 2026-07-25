import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Clock, Mail, Save } from 'lucide-react';
import { api, type NotificationProfile } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

/** 0 = Sunday, matching the backend and `Date.getDay()`. */
const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** A short, curated zone list plus whatever the browser reports. */
function timezoneOptions(current: string | null): string[] {
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = [
    'America/Puerto_Rico', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Europe/London', 'Europe/Madrid', 'Europe/Berlin', 'UTC',
  ];
  return [...new Set([current, guess, ...base].filter(Boolean) as string[])];
}

/**
 * Profile-wide personal notification settings: timezone, quiet hours, digests and
 * the global pause.
 *
 * Quiet hours and digests are evaluated in the timezone chosen here, not the
 * server's — so the zone is presented first and explained, rather than buried as an
 * advanced option. An overnight window (end before start) is normal and supported;
 * the form says so instead of letting it look like a mistake.
 */
export function NotificationSettingsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();

  const profile = useQuery({
    queryKey: ['account', 'notifications', 'profile'],
    queryFn: () => api.account.notifications.profile(),
  });

  const [draft, setDraft] = useState<NotificationProfile | null>(null);
  useEffect(() => {
    if (profile.data && !draft) setDraft(profile.data);
  }, [profile.data, draft]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['account', 'notifications', 'profile'] });

  const save = useMutation({
    mutationFn: (body: Partial<NotificationProfile>) => api.account.notifications.updateProfile(body),
    onSuccess: (p) => { setDraft(p); void invalidate(); toast.success(t('mySettings.saved')); },
    // The backend validates times and zones before writing, so its message is the
    // useful one — a generic "could not save" would hide which field was wrong.
    onError: (e: Error) => toast.error(e?.message || t('mySettings.saveFailed')),
  });

  const pause = useMutation({
    mutationFn: (until?: string) => api.account.notifications.pause(until),
    onSuccess: (p) => { setDraft(p); void invalidate(); toast.success(t('mySettings.paused')); },
  });
  const resume = useMutation({
    mutationFn: () => api.account.notifications.resume(),
    onSuccess: (p) => { setDraft(p); void invalidate(); toast.success(t('mySettings.resumed')); },
  });

  if (profile.isLoading || !draft) return <CenteredSpinner />;
  if (profile.isError) {
    return <ErrorState title={t('mySettings.loadError')} onRetry={() => void profile.refetch()} />;
  }

  const set = <K extends keyof NotificationProfile>(key: K, value: NotificationProfile[K]) =>
    setDraft({ ...draft, [key]: value });

  const toggleDay = (day: number) => {
    const days = draft.quietHoursDays.includes(day)
      ? draft.quietHoursDays.filter((d) => d !== day)
      : [...draft.quietHoursDays, day].sort();
    set('quietHoursDays', days);
  };

  // End before start is an overnight window, not an error — say so rather than
  // letting a normal night look like a mistake.
  const isOvernight =
    draft.quietHoursEnabled && !!draft.quietHoursStart && !!draft.quietHoursEnd &&
    draft.quietHoursEnd < draft.quietHoursStart;

  const submit = () =>
    save.mutate({
      timezone: draft.timezone,
      quietHoursEnabled: draft.quietHoursEnabled,
      quietHoursStart: draft.quietHoursStart,
      quietHoursEnd: draft.quietHoursEnd,
      quietHoursDays: draft.quietHoursDays,
      digestDaily: draft.digestDaily,
      digestDailyAt: draft.digestDailyAt,
      digestWeekly: draft.digestWeekly,
      digestWeeklyDay: draft.digestWeeklyDay,
      digestWeeklyAt: draft.digestWeeklyAt,
    });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('mySettings.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('mySettings.subtitle')}</p>
      </div>

      {/* Pause — first, because someone opening this page in a hurry usually wants it. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <BellOff className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('mySettings.pauseTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {draft.paused && draft.pausedUntil
                ? t('mySettings.pausedUntil', { when: new Date(draft.pausedUntil).toLocaleString() })
                : t('mySettings.pauseHint')}
            </p>
          </div>
          {draft.paused ? (
            <Button variant="secondary" size="sm" onClick={() => resume.mutate()}>
              {t('mySettings.resume')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm"
                onClick={() => pause.mutate(new Date(Date.now() + 3600_000).toISOString())}>
                {t('mySettings.pause1h')}
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => pause.mutate(new Date(Date.now() + 24 * 3600_000).toISOString())}>
                {t('mySettings.pause24h')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Timezone — presented first because everything below is evaluated in it. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4" /> {t('mySettings.timezone')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('mySettings.timezoneHint')}</p>
          <div className="sm:max-w-sm">
            <Select
              aria-label={t('mySettings.timezone')}
              value={draft.timezone ?? ''}
              onChange={(e) => set('timezone', e.target.value || null)}
              options={[
                { value: '', label: t('mySettings.timezoneServer') },
                ...timezoneOptions(draft.timezone).map((z) => ({ value: z, label: z })),
              ]}
            />
          </div>
        </CardContent>
      </Card>

      {/* Quiet hours */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="flex-1 text-sm font-semibold">{t('mySettings.quietHours')}</h2>
            <Switch
              checked={draft.quietHoursEnabled}
              onCheckedChange={(v: boolean) => set('quietHoursEnabled', v)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('mySettings.quietHoursHint')}</p>

          {draft.quietHoursEnabled && (
            <>
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="qh-start">{t('mySettings.from')}</Label>
                  <Input id="qh-start" type="time" value={draft.quietHoursStart ?? ''}
                    onChange={(e) => set('quietHoursStart', e.target.value || null)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qh-end">{t('mySettings.to')}</Label>
                  <Input id="qh-end" type="time" value={draft.quietHoursEnd ?? ''}
                    onChange={(e) => set('quietHoursEnd', e.target.value || null)} />
                </div>
              </div>

              {isOvernight && (
                <Badge variant="outline">{t('mySettings.overnight')}</Badge>
              )}

              <div className="space-y-1.5">
                <Label>{t('mySettings.days')}</Label>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={draft.quietHoursDays.includes(d)}
                        onCheckedChange={() => toggleDay(d)}
                      />
                      {t(`mySettings.day.${d}` as never, { defaultValue: String(d) })}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('mySettings.daysHint')}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Digests */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="h-4 w-4" /> {t('mySettings.digests')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('mySettings.digestsHint')}</p>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Switch checked={draft.digestDaily} onCheckedChange={(v: boolean) => set('digestDaily', v)} />
              <span className="flex-1 text-sm">{t('mySettings.daily')}</span>
              {draft.digestDaily && (
                <Input aria-label={t('mySettings.dailyAt')} type="time" className="w-32"
                  value={draft.digestDailyAt ?? ''}
                  onChange={(e) => set('digestDailyAt', e.target.value || null)} />
              )}
            </div>
            {draft.digestDaily && draft.nextDailyDigestAt && (
              <p className="text-xs text-muted-foreground">
                {t('mySettings.next', { when: new Date(draft.nextDailyDigestAt).toLocaleString() })}
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-white/5 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <Switch checked={draft.digestWeekly} onCheckedChange={(v: boolean) => set('digestWeekly', v)} />
              <span className="flex-1 text-sm">{t('mySettings.weekly')}</span>
              {draft.digestWeekly && (
                <>
                  <Select aria-label={t('mySettings.weeklyDay')} className="w-36"
                    value={String(draft.digestWeeklyDay ?? 1)}
                    onChange={(e) => set('digestWeeklyDay', Number(e.target.value))}
                    options={DAYS.map((d) => ({
                      value: String(d),
                      label: t(`mySettings.day.${d}` as never, { defaultValue: String(d) }),
                    }))} />
                  <Input aria-label={t('mySettings.weeklyAt')} type="time" className="w-32"
                    value={draft.digestWeeklyAt ?? ''}
                    onChange={(e) => set('digestWeeklyAt', e.target.value || null)} />
                </>
              )}
            </div>
            {draft.digestWeekly && draft.nextWeeklyDigestAt && (
              <p className="text-xs text-muted-foreground">
                {t('mySettings.next', { when: new Date(draft.nextWeeklyDigestAt).toLocaleString() })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={save.isPending}>
          <Save className="h-3.5 w-3.5" /> {t('mySettings.save')}
        </Button>
      </div>
    </div>
  );
}
