import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';

/**
 * The consent step before UltraTorrent starts pausing someone's torrents.
 *
 * It shows the counts from a preview of the CURRENT queue rather than a generic
 * warning, because "this will pause 34 torrents" is a fact an operator can act
 * on and "are you sure?" is not. Blockers disable the button outright; warnings
 * are shown and do not, since they are things to know rather than reasons to
 * refuse.
 */
export function ActivationDialog({
  engineId, onClose, onDone,
}: { engineId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation('torrents');
  const toast = useToast();

  const preview = useQuery({
    queryKey: ['torrent-scheduler', 'activation', engineId],
    queryFn: () => api.torrentScheduler.describeActivation(engineId),
  });

  const activate = useMutation({
    mutationFn: () => api.torrentScheduler.activate(engineId),
    onSuccess: onDone,
    onError: (e) =>
      toast.error(t('scheduler.activation.activateFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const blocked = (preview.data?.blockers.length ?? 0) > 0;

  return (
    <Dialog open onClose={onClose} title={t('scheduler.activation.title')}>
      <DialogHeader>
        <DialogTitle>{t('scheduler.activation.title')}</DialogTitle>
        <DialogDescription>{t('scheduler.activation.intro')}</DialogDescription>
      </DialogHeader>

      {preview.isLoading ? <CenteredSpinner /> : preview.data ? (
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-4">
            <Count label={t('scheduler.activation.wouldPause')} value={preview.data.wouldPause} emphasis />
            <Count label={t('scheduler.activation.wouldResume')} value={preview.data.wouldResume} />
            <Count label={t('scheduler.activation.totalTorrents')} value={preview.data.totalTorrents} />
          </div>

          {preview.data.blockers.length > 0 && (
            <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <ShieldAlert className="h-4 w-4" /> {t('scheduler.activation.blockers')}
              </h3>
              {preview.data.blockers.map((b) => (
                <p key={b.code} className="text-sm text-muted-foreground">
                  {t(`scheduler.activation.blocker.${b.code}` as 'scheduler.activation.blocker.engine_cannot_pause')}
                </p>
              ))}
            </div>
          )}

          {preview.data.warnings.length > 0 && (
            <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <TriangleAlert className="h-4 w-4 text-warning" /> {t('scheduler.activation.warnings')}
              </h3>
              {preview.data.warnings.map((w) => (
                <p key={w.code} className="text-sm text-muted-foreground">
                  {t(`scheduler.activation.warning.${w.code}` as 'scheduler.activation.warning.no_policies')}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('scheduler.activation.cancel')}</Button>
        <Button
          variant="destructive"
          disabled={blocked || preview.isLoading}
          loading={activate.isPending}
          onClick={() => activate.mutate()}
        >
          {t('scheduler.activation.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Switching enforcement off.
 *
 * The resume toggle defaults to OFF, and says why: resuming everything would
 * start downloads the operator did not choose to start, on an engine whose own
 * limits are about to take over again.
 */
export function DeactivationDialog({
  engineId, onClose, onDone,
}: { engineId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation('torrents');
  const toast = useToast();
  const [resumePaused, setResumePaused] = useState(false);

  const preview = useQuery({
    queryKey: ['torrent-scheduler', 'activation', engineId],
    queryFn: () => api.torrentScheduler.describeActivation(engineId),
  });

  const deactivate = useMutation({
    mutationFn: () => api.torrentScheduler.deactivate(engineId, resumePaused),
    onSuccess: onDone,
    onError: (e) =>
      toast.error(t('scheduler.activation.activateFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} title={t('scheduler.activation.deactivateTitle')}>
      <DialogHeader>
        <DialogTitle>{t('scheduler.activation.deactivateTitle')}</DialogTitle>
        <DialogDescription>{t('scheduler.activation.deactivateIntro')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        {preview.data && (
          <p className="text-sm text-muted-foreground">
            {t('scheduler.activation.heldPaused', { count: preview.data.wouldResume })}
          </p>
        )}
        <div className="rounded-md border border-border/60 px-3 py-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="resume-paused">{t('scheduler.activation.resumePaused')}</Label>
            <Switch id="resume-paused" checked={resumePaused} onCheckedChange={setResumePaused} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('scheduler.activation.resumePausedHelp')}
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('scheduler.activation.cancel')}</Button>
        <Button onClick={() => deactivate.mutate()} loading={deactivate.isPending}>
          {t('scheduler.activation.deactivateConfirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Count({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tabular-nums ${emphasis && value > 0 ? 'text-warning' : ''}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
