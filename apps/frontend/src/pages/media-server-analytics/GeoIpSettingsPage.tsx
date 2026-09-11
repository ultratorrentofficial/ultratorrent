import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, DownloadCloud, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError, type GeoIpConfig, type GeoIpStatus, type GeoIpDbInfo } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/format';

const REDACTED = '••••••••';
const EDITIONS = ['GeoLite2-City', 'GeoLite2-ASN'] as const;

/**
 * IP geolocation setup — the MaxMind analogue of the IMDb dataset admin: a
 * credential/config area, a database status readout, and a manual "Update now",
 * with an automatic refresh the backend runs on a schedule.
 */
export function GeoIpSettingsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();

  const config = useQuery({ queryKey: ['geoip', 'config'], queryFn: () => api.geoip.config() });
  const status = useQuery({
    queryKey: ['geoip', 'status'],
    queryFn: () => api.geoip.status(),
    refetchInterval: (q) => (q.state.data?.updating ? 2000 : false),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Globe className="h-6 w-6" /> {t('geoip.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('geoip.subtitle')}</p>
      </div>

      {config.isLoading ? (
        <CenteredSpinner />
      ) : config.isError || !config.data ? (
        <ErrorState title={t('geoip.loadError')} onRetry={() => void config.refetch()} />
      ) : (
        <ConfigForm
          initial={config.data}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['geoip'] });
          }}
        />
      )}

      {status.data && <StatusPanel status={status.data} onChanged={() => void qc.invalidateQueries({ queryKey: ['geoip'] })} />}
    </div>
  );
}

function ConfigForm({ initial, onSaved }: { initial: GeoIpConfig; onSaved: () => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const [accountId, setAccountId] = useState(initial.accountId ?? '');
  // Prefilled with the redaction dots when a key exists; only sent if changed.
  const [licenseKey, setLicenseKey] = useState(initial.hasLicenseKey ? REDACTED : '');
  const [autoUpdate, setAutoUpdate] = useState(initial.autoUpdate);
  const [intervalHours, setIntervalHours] = useState(initial.updateIntervalHours);
  const [editions, setEditions] = useState<string[]>(initial.editions);

  useEffect(() => {
    setAccountId(initial.accountId ?? '');
    setLicenseKey(initial.hasLicenseKey ? REDACTED : '');
    setAutoUpdate(initial.autoUpdate);
    setIntervalHours(initial.updateIntervalHours);
    setEditions(initial.editions);
  }, [initial]);

  const save = useMutation({
    mutationFn: () =>
      api.geoip.updateConfig({
        accountId: accountId.trim() || null,
        // Unchanged (still the dots) → omit, so the stored key is kept.
        licenseKey: licenseKey === REDACTED ? undefined : licenseKey.trim() || null,
        autoUpdate,
        updateIntervalHours: intervalHours,
        editions,
      }),
    onSuccess: () => {
      toast.success(t('geoip.saved'));
      onSaved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('geoip.saveError')),
  });

  const toggleEdition = (e: string) =>
    setEditions((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="geoip-account">{t('geoip.accountId')}</Label>
            <Input id="geoip-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="1234567" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="geoip-key">{t('geoip.licenseKey')}</Label>
            <Input
              id="geoip-key"
              type="password"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onFocus={(e) => { if (e.target.value === REDACTED) setLicenseKey(''); }}
              placeholder={t('geoip.licenseKeyPlaceholder')}
              autoComplete="off"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('geoip.credHint')}{' '}
          <a href="https://www.maxmind.com/en/geolite2/signup" target="_blank" rel="noreferrer" className="underline">
            maxmind.com/en/geolite2/signup
          </a>
        </p>

        <div className="space-y-2">
          <Label>{t('geoip.editions')}</Label>
          <div className="flex flex-wrap gap-4">
            {EDITIONS.map((e) => (
              <label key={e} className="flex items-center gap-2 text-sm">
                <Checkbox checked={editions.includes(e)} onCheckedChange={() => toggleEdition(e)} />
                <span>{e}</span>
                <span className="text-xs text-muted-foreground">
                  {e === 'GeoLite2-City' ? t('geoip.editionCity') : t('geoip.editionAsn')}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoUpdate} onCheckedChange={(v) => setAutoUpdate(Boolean(v))} />
            <span>{t('geoip.autoUpdate')}</span>
          </label>
          <div className="flex items-center gap-2">
            <Label htmlFor="geoip-interval" className="text-sm">{t('geoip.every')}</Label>
            <Input
              id="geoip-interval"
              type="number"
              min={1}
              value={intervalHours}
              onChange={(e) => setIntervalHours(Math.max(1, Number(e.target.value) || 1))}
              className="w-20"
              disabled={!autoUpdate}
            />
            <span className="text-sm text-muted-foreground">{t('geoip.hours')}</span>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('geoip.saving') : t('geoip.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPanel({ status, onChanged }: { status: GeoIpStatus; onChanged: () => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();

  const update = useMutation({
    mutationFn: () => api.geoip.updateNow(),
    onSuccess: (r) => {
      if (r.ok) toast.success(t('geoip.updateDone'));
      else toast.error(t('geoip.updatePartial'));
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('geoip.updateError')),
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t('geoip.databases')}</h2>
          <Button
            variant="secondary"
            onClick={() => update.mutate()}
            disabled={!status.configured || status.updating || update.isPending}
            title={!status.configured ? t('geoip.needCreds') : undefined}
          >
            {status.updating || update.isPending ? (
              <><RefreshCw className="h-4 w-4 animate-spin" /> {t('geoip.updating')}</>
            ) : (
              <><DownloadCloud className="h-4 w-4" /> {t('geoip.updateNow')}</>
            )}
          </Button>
        </div>

        {!status.configured && (
          <p className="flex items-center gap-2 text-sm text-amber-500">
            <AlertTriangle className="h-4 w-4" /> {t('geoip.needCreds')}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <DbCard label="GeoLite2-City" info={status.databases.city} t={t} />
          <DbCard label="GeoLite2-ASN" info={status.databases.asn} t={t} />
        </div>

        {status.lastRun && (
          <p className="text-xs text-muted-foreground" title={formatDateTime(status.lastRun.ranAt)}>
            {t('geoip.lastRun', { when: formatRelativeTime(status.lastRun.ranAt) })}
            {' · '}
            {status.lastRun.editions.map((e) => `${e.edition}: ${e.ok ? '✓' : e.error ?? '✗'}`).join(' · ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DbCard({ label, info, t }: { label: string; info: GeoIpDbInfo; t: TFunction<'mediaServerAnalytics'> }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        {info.present ? (
          <span className="flex items-center gap-1 text-xs text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> {t('geoip.installed')}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('geoip.notInstalled')}</span>
        )}
      </div>
      {info.present && (
        <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {info.buildEpoch != null && (
            <div className="flex justify-between"><dt>{t('geoip.built')}</dt><dd>{formatDateTime(new Date(info.buildEpoch * 1000).toISOString())}</dd></div>
          )}
          {info.sizeBytes != null && (
            <div className="flex justify-between"><dt>{t('geoip.size')}</dt><dd className="tabular-nums">{formatBytes(info.sizeBytes)}</dd></div>
          )}
          {info.modifiedAt && (
            <div className="flex justify-between"><dt>{t('geoip.updatedAt')}</dt><dd>{formatRelativeTime(info.modifiedAt)}</dd></div>
          )}
        </dl>
      )}
    </div>
  );
}
