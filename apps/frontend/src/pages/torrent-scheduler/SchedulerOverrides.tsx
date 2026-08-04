import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { ApiError, api, type SchedulerOverride, type SchedulerOverrideKind } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { formatRelativeTime } from '@/lib/format';

/**
 * Instructions about one torrent.
 *
 * Each kind explains its own consequence where it is chosen, because the
 * differences are not guessable from the names. "Protect from pause" and
 * "exclude" sound interchangeable and are not: a protected torrent still counts
 * toward the limits and can still be started by the scheduler, while an excluded
 * one is outside its authority in both directions.
 */
const KINDS: SchedulerOverrideKind[] = [
  'protect_from_pause', 'protect_from_removal', 'exclude', 'force_start',
];

export function SchedulerOverrides({ engineId }: { engineId: string }) {
  const { t } = useTranslation('torrents');
  const { hasPermission } = useAuth();
  const canOverride = hasPermission(PERMISSIONS.TORRENT_SCHEDULER_OVERRIDE);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const overrides = useQuery({
    queryKey: ['torrent-scheduler', 'overrides', engineId],
    queryFn: () => api.torrentScheduler.overrides(engineId),
  });

  const clear = useMutation({
    mutationFn: (o: SchedulerOverride) =>
      api.torrentScheduler.clearOverride(engineId, o.hash, o.kind),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] }),
    onError: (e) =>
      toast.error(t('scheduler.overrides.clearFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="h-4 w-4" /> {t('scheduler.overrides.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('scheduler.overrides.help')}</p>
          </div>
          {canOverride && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('scheduler.overrides.add')}
            </Button>
          )}
        </div>

        {!overrides.data?.length ? (
          <p className="text-sm text-muted-foreground">{t('scheduler.overrides.none')}</p>
        ) : (
          <div className="space-y-2">
            {overrides.data.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs">{o.hash.slice(0, 12)}</code>
                    <Badge variant="secondary">
                      {t(`scheduler.overrides.kind.${o.kind}` as 'scheduler.overrides.kind.exclude')}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t('scheduler.overrides.expires')}:{' '}
                    {o.expiresAt ? formatRelativeTime(o.expiresAt) : t('scheduler.overrides.never')}
                  </div>
                </div>
                {canOverride && (
                  <Button variant="ghost" size="sm" onClick={() => clear.mutate(o)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {adding && (
          <OverrideDialog
            engineId={engineId}
            onClose={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function OverrideDialog({
  engineId, onClose, onSaved,
}: { engineId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('torrents');
  const toast = useToast();
  const [hash, setHash] = useState('');
  const [kind, setKind] = useState<SchedulerOverrideKind>('protect_from_pause');
  const [minutes, setMinutes] = useState('');

  const save = useMutation({
    mutationFn: () => api.torrentScheduler.setOverride(engineId, hash.trim(), {
      kind,
      expiresInMinutes: minutes.trim() === '' ? null : Number(minutes),
    }),
    onSuccess: onSaved,
    onError: (e) =>
      toast.error(t('scheduler.overrides.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} title={t('scheduler.overrides.add')}>
      <DialogHeader>
        <DialogTitle>{t('scheduler.overrides.add')}</DialogTitle>
        <DialogDescription>{t('scheduler.overrides.help')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="ov-hash">{t('scheduler.overrides.torrentHash')}</Label>
          <Input id="ov-hash" value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} />
        </div>
        <div>
          <Label htmlFor="ov-kind">{t('scheduler.overrides.title')}</Label>
          <Select
            id="ov-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as SchedulerOverrideKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`scheduler.overrides.kind.${k}` as 'scheduler.overrides.kind.exclude')}
              </option>
            ))}
          </Select>
          {/* The consequence, where the choice is made — these are not
              guessable from the names. */}
          <p className="mt-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {t(`scheduler.overrides.kindHelp.${kind}` as 'scheduler.overrides.kindHelp.exclude')}
          </p>
        </div>
        <div className="w-48">
          <Label htmlFor="ov-expiry">{t('scheduler.overrides.expiresInMinutes')}</Label>
          <Input
            id="ov-expiry"
            type="number"
            min={1}
            value={minutes}
            placeholder={t('scheduler.overrides.never')}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('scheduler.activation.cancel')}</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!hash.trim()}>
          {t('scheduler.overrides.add')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
