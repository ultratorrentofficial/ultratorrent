import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError, type BandwidthSource, type EngineBandwidthStatus } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge, type BadgeVariant } from '@/components/ui/badge';

/**
 * Settings → Global bandwidth. One ceiling for every engine, which the Activity
 * Scheduler overrides only on engines it is actually governing.
 *
 * The per-engine outcome is RENDERED FROM THE API rather than re-derived here.
 * The rule — managed mode plus a covering policy — lives in one place on the
 * server, and a screen that restated it in its own words would be a second
 * description free to drift from what the system does.
 */

const SOURCE_VARIANT: Record<BandwidthSource, BadgeVariant> = {
  settings: 'success',
  scheduler: 'secondary',
  unconfigured: 'warning',
  observing: 'secondary',
  unsupported: 'destructive',
};

/** Empty means unlimited; anything unparseable is treated as empty. */
function toValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function BandwidthSettingsCard() {
  const { t } = useTranslation('settings');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = hasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const q = useQuery({ queryKey: ['bandwidth', 'settings'], queryFn: () => api.bandwidth.get() });

  const [down, setDown] = useState('');
  const [up, setUp] = useState('');

  useEffect(() => {
    if (!q.data) return;
    setDown(q.data.settings?.maxDownloadRateKbps?.toString() ?? '');
    setUp(q.data.settings?.maxUploadRateKbps?.toString() ?? '');
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      api.bandwidth.update({ maxDownloadRateKbps: toValue(down), maxUploadRateKbps: toValue(up) }),
    onSuccess: () => {
      toast.success(t('bandwidth.saved'));
      queryClient.invalidateQueries({ queryKey: ['bandwidth'] });
    },
    onError: (err) =>
      toast.error(t('bandwidth.saveFailed'), err instanceof ApiError ? err.message : undefined),
  });

  /** What is actually in force on this engine, in words. */
  const describe = (engine: EngineBandwidthStatus): string => {
    if (engine.source !== 'settings') return '';
    const fmt = (v: number | null) => (v == null ? t('bandwidth.unlimited') : `${v} kbps`);
    return t('bandwidth.inForce', {
      down: fmt(engine.maxDownloadRateKbps),
      up: fmt(engine.maxUploadRateKbps),
    });
  };

  const engines = q.data?.engines ?? [];
  // Worth surfacing on its own: a limit that reaches nothing looks configured.
  const unreachable = engines.filter((e) => e.source === 'unsupported');

  /*
   * How many engines this ceiling actually reaches, and therefore what the
   * installation can use in total.
   *
   * Each engine receives the FULL figure — every shipped engine sets its own
   * limit and cannot see the others, so there is no shared total to enforce.
   * Two engines at 25 000 kbps is 50 000 kbps of real capacity, and a screen
   * that showed only the per-engine number would let an operator read it as a
   * cap on the installation. Stated here, where the multiplication is, rather
   * than left for someone to work out.
   */
  const receiving = engines.filter((e) => e.source === 'settings');
  const aggregate = (value: number | null): string =>
    (value == null ? t('bandwidth.unlimited') : `${value * receiving.length} kbps`);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start gap-3">
          <Gauge className="mt-1 h-5 w-5 text-muted-foreground" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold">{t('bandwidth.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('bandwidth.description')}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="bandwidth-down">{t('bandwidth.download')}</Label>
            <Input
              id="bandwidth-down"
              inputMode="numeric"
              value={down}
              disabled={!canManage}
              placeholder={t('bandwidth.unlimited')}
              onChange={(e) => setDown(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bandwidth-up">{t('bandwidth.upload')}</Label>
            <Input
              id="bandwidth-up"
              inputMode="numeric"
              value={up}
              disabled={!canManage}
              placeholder={t('bandwidth.unlimited')}
              onChange={(e) => setUp(e.target.value)}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{t('bandwidth.emptyMeansUnlimited')}</p>

        {receiving.length > 0 && (
          <p className={`text-xs ${receiving.length > 1 ? 'text-warning' : 'text-muted-foreground'}`}>
            {t('bandwidth.aggregate', {
              count: receiving.length,
              down: aggregate(receiving[0].maxDownloadRateKbps),
              up: aggregate(receiving[0].maxUploadRateKbps),
            })}
          </p>
        )}

        {unreachable.length > 0 && (
          <p className="text-xs text-destructive">
            {t('bandwidth.unreachable', { engines: unreachable.map((e) => e.engineId).join(', ') })}
          </p>
        )}

        {engines.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('bandwidth.perEngine')}</p>
            <ul className="space-y-1">
              {engines.map((engine) => (
                <li key={engine.engineId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-mono">{engine.engineId}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{describe(engine)}</span>
                    <Badge variant={SOURCE_VARIANT[engine.source]}>
                      {t(`bandwidth.source.${engine.source}`)}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!canManage || save.isPending}>
            {t('bandwidth.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
