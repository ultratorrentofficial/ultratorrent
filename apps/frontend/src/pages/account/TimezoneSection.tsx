import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { availableTimezones, deviceTimezone } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/** Sentinel for "follow the device" — a `<select>` cannot carry a null value. */
const AUTO = '';

/**
 * Choose the timezone every timestamp is shown in.
 *
 * The preview is the point of the control. A zone name is not something most
 * people can evaluate — `America/Puerto_Rico` versus `America/Santo_Domingo`
 * looks like a coin toss — but "2:30 AM" versus "6:30 AM" is immediately either
 * right or wrong. It updates as the selection changes, before saving, so the
 * choice can be checked rather than guessed at.
 */
export function TimezoneSection({
  timezone,
  onSaved,
}: {
  timezone: string | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation('account');
  const { refreshUser } = useAuth();
  const toast = useToast();

  const [value, setValue] = useState<string>(timezone ?? AUTO);
  const [saving, setSaving] = useState(false);

  const zones = useMemo(() => availableTimezones(), []);
  const device = useMemo(() => deviceTimezone(), []);

  /*
   * A zone stored before this runtime knew it — or written by another client —
   * would otherwise vanish from the list and silently reset to "follow the
   * device" on the next save.
   */
  const options = useMemo(() => {
    const all = new Set(zones);
    if (timezone) all.add(timezone);
    return [...all].sort();
  }, [zones, timezone]);

  const preview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: value || undefined,
      }).format(new Date());
    } catch {
      return '—';
    }
  }, [value]);

  const dirty = (timezone ?? AUTO) !== value;

  const save = async () => {
    setSaving(true);
    try {
      await api.account.updateProfile({ timezone: value === AUTO ? null : value });
      // Refresh the identity, not just this page: the zone lives on the auth
      // user and drives every timestamp in the app.
      await refreshUser();
      toast.success(t('timezone.saved'));
      onSaved();
    } catch (err) {
      toast.error((err as Error)?.message || t('timezone.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4" aria-hidden />
          {t('timezone.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('timezone.description')}</p>

        <div className="space-y-1.5">
          <Label htmlFor="pf-timezone">{t('timezone.label')}</Label>
          {options.length > 0 ? (
            /* The shared Select, not a hand-rolled one: it carries the design
               system's chrome and the chevron, and its `bg-card` follows the
               theme rather than a literal colour. */
            <Select id="pf-timezone" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value={AUTO}>{t('timezone.auto', { zone: device })}</option>
              {options.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          ) : (
            /* Older runtimes cannot enumerate zones; free text beats an empty
               dropdown, and the server validates either way. */
            <Input
              id="pf-timezone"
              value={value}
              placeholder={device}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('timezone.previewLabel')}
          </p>
          <p className="mt-0.5 text-sm tabular-nums">{preview}</p>
        </div>

        <Button size="sm" disabled={!dirty || saving} loading={saving} onClick={save}>
          {t('timezone.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
