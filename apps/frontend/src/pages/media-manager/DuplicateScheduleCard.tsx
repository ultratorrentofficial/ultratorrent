import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatDateTime } from '@/lib/format';

/**
 * Duplicates Center → recurring scan.
 *
 * Detection had no trigger of its own: it ran only when somebody opened this
 * page and pressed Scan. Everything else recurring in the product is driven, so
 * this was the one place a real finding waited on being remembered — two copies
 * of one film sat ungrouped for two days on a live host and surfaced only
 * because a move failed.
 *
 * Running it on a timer is close to free: detection digests its input first and
 * returns immediately when nothing has changed, so an idle library costs one
 * query rather than a full pass.
 */

const CHOICES = [6, 12, 24, 168] as const;

export function DuplicateScheduleCard() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_SCAN);
  const q = useQuery({
    queryKey: ['media', 'duplicate-schedule'],
    queryFn: () => api.media.duplicateSchedule(),
  });

  const [enabled, setEnabled] = useState(false);
  const [hours, setHours] = useState<number>(24);

  useEffect(() => {
    if (!q.data) return;
    setEnabled(q.data.enabled);
    setHours(q.data.intervalHours);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.media.setDuplicateSchedule({ enabled, intervalHours: hours }),
    onSuccess: () => {
      toast.success(t('duplicates.schedule.saved'));
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicate-schedule'] });
    },
    onError: (e) =>
      toast.error(t('duplicates.schedule.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const label = (h: number) =>
    h === 168 ? t('duplicates.schedule.weekly') : t('duplicates.schedule.everyHours', { hours: h });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-1 h-5 w-5 text-muted-foreground" aria-hidden />
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{t('duplicates.schedule.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('duplicates.schedule.description')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="dup-sched-enabled"
              checked={enabled}
              disabled={!canManage}
              onCheckedChange={setEnabled}
            />
            <Label htmlFor="dup-sched-enabled">{t('duplicates.schedule.enabled')}</Label>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="dup-sched-every">{t('duplicates.schedule.frequency')}</Label>
            <select
              id="dup-sched-every"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
              value={hours}
              disabled={!canManage || !enabled}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              {CHOICES.map((h) => (
                <option key={h} value={h}>{label(h)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {q.data?.lastRunAt
              ? t('duplicates.schedule.lastRun', { when: formatDateTime(q.data.lastRunAt) })
              : t('duplicates.schedule.neverRun')}
          </p>
          {/* Only meaningful while enabled — the server returns null otherwise. */}
          {q.data?.nextRunAt && (
            <p>{t('duplicates.schedule.nextRun', { when: formatDateTime(q.data.nextRunAt) })}</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t('duplicates.schedule.cheapNote')}</p>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!canManage || save.isPending}>
            {t('duplicates.schedule.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
