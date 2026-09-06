import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Circle, Info, RefreshCw, XCircle } from 'lucide-react';
import { api, type DiscoveryProviderStatus } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

/**
 * Provider management.
 *
 * Three states an operator has to be able to tell apart, because the action is
 * different for each and only one of them is a fault:
 *
 *  - **Not configured** — the provider exists but this installation has no
 *    credential for it. Says WHERE to set one, because "not configured" without
 *    a location is a dead end.
 *  - **Configured but off** — silent by choice. The normal state of a fresh
 *    install, and not a problem.
 *  - **On and unhealthy** — the only one that wants attention, carrying the last
 *    failure reason rather than a red dot to be interpreted.
 *
 * Health is read from what the last sync recorded rather than probed on render:
 * a page load must not wait on a third party, and a transient blip is not the
 * provider's condition.
 */

/** Capability id → the short phrase the screen shows for it. */
const CAPABILITY_LABEL: Record<string, string> = {
  upcoming_movies: 'Upcoming films',
  upcoming_series: 'New series',
  returning_series: 'Returning series',
  upcoming_seasons: 'New seasons',
  upcoming_episodes: 'Episodes',
  trending: 'Trending',
  popular: 'Popular',
  details: 'Details',
};

function StateIcon({ provider }: { provider: DiscoveryProviderStatus }) {
  if (!provider.registered) return <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />;
  if (!provider.enabled) return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (provider.healthy === false) return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
}

function ProviderCard({ provider }: { provider: DiscoveryProviderStatus }) {
  const { t } = useTranslation('mediaDiscovery');
  const qc = useQueryClient();
  const toast = useToast();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['discovery'] });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.mediaDiscovery.setProviderEnabled(provider.provider, enabled),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const sync = useMutation({
    mutationFn: () => api.mediaDiscovery.sync([provider.provider]),
    onSuccess: () => {
      toast.success(t('actions.syncQueued'));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="space-y-2.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StateIcon provider={provider} />
            <span className="text-sm font-semibold">{provider.provider}</span>
            {!provider.registered && (
              <Badge variant="outline" className="text-[10px]">{t('providers.notConfigured')}</Badge>
            )}
            {provider.registered && !provider.enabled && (
              <Badge variant="outline" className="text-[10px]">{t('providers.off')}</Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={!provider.registered || !provider.enabled || sync.isPending}
              onClick={() => sync.mutate()}
              title={t('providers.syncOne')}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              size="sm"
              variant={provider.enabled ? 'secondary' : 'primary'}
              disabled={!provider.registered || toggle.isPending}
              onClick={() => toggle.mutate(!provider.enabled)}
            >
              {provider.enabled ? t('providers.disable') : t('providers.enable')}
            </Button>
          </div>
        </div>

        {/*
          * The one place a fix is actionable. "Not configured" with no location
          * is a dead end — the TMDB key lives in Media Manager settings, which
          * nobody would guess from a Discovery screen.
          */}
        {provider.configurationHint && (
          <p className="flex items-start gap-1.5 rounded bg-amber-400/10 px-2 py-1.5 text-xs text-amber-200">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {provider.configurationHint}
          </p>
        )}

        {provider.enabled && provider.healthy === false && provider.lastFailureReason && (
          <p className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {provider.lastFailureReason}
          </p>
        )}

        <div className="flex flex-wrap gap-1">
          {provider.capabilities.map((c) => (
            <span key={c} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {CAPABILITY_LABEL[c] ?? c}
            </span>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-3">
          <div>
            <dt className="opacity-70">{t('providers.discoveredLabel')}</dt>
            <dd className="tabular-nums text-foreground">{provider.itemsDiscovered}</dd>
          </div>
          <div>
            <dt className="opacity-70">{t('providers.lastSync')}</dt>
            <dd>{provider.lastSuccessfulSync ? formatDateTime(provider.lastSuccessfulSync) : t('providers.never')}</dd>
          </div>
          <div>
            <dt className="opacity-70">{t('providers.responseTime')}</dt>
            <dd className="tabular-nums">
              {provider.lastResponseMs != null ? `${provider.lastResponseMs} ms` : '—'}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

export function ProvidersPanel() {
  const { t } = useTranslation('mediaDiscovery');
  const providers = useQuery({
    queryKey: ['discovery', 'providers'],
    queryFn: () => api.mediaDiscovery.providers(),
  });

  if (providers.isLoading) return <CenteredSpinner />;
  if (providers.isError) return <ErrorState title={t('providers.error')} />;
  if (!providers.data?.length) {
    return (
      <EmptyState
        icon={<AlertCircle className="h-6 w-6" />}
        title={t('providers.noneTitle')}
        description={t('providers.noneDescription')}
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('providers.explainer')}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {providers.data.map((p) => (
          <ProviderCard key={p.provider} provider={p} />
        ))}
      </div>
    </div>
  );
}
