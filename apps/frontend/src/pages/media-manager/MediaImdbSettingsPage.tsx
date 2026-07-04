import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS, type ImdbEventPayload } from '@ultratorrent/shared';
import {
  Activity,
  Database,
  Film,
  Plug,
  DownloadCloud,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import {
  ApiError,
  api,
  type ImdbDatasetValidationReport,
  type ImdbSettings,
  type ImdbSettingsInput,
  type ImdbStatus,
} from '@/lib/api';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { wsClient } from '@/lib/ws';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { PathPicker } from '@/components/PathPicker';
import {
  imdbModeOptions,
  imdbDatasetFileLabel,
  imdbImportStatusVariant,
  imdbModeLabel,
} from './constants';

const REDACTED = '••••••••';

/** Live progress for an in-flight dataset import, driven by WS events. */
interface LiveImport {
  importId: string | null;
  status: string;
  progress: number; // 0..100
  message: string | null;
  recordsImported: number;
  error: string | null;
}

export function MediaImdbSettingsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canView = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW);
  const canConfigure = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_CONFIGURE);
  const canImport = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_IMPORT_DATASET);
  const { t } = useTranslation('imdb');

  const statusQuery = useQuery({
    queryKey: ['media', 'imdb', 'status'],
    queryFn: api.media.imdbStatus,
    enabled: canView,
  });
  const settingsQuery = useQuery({
    queryKey: ['media', 'imdb', 'settings'],
    queryFn: api.media.imdbSettings,
    enabled: canView,
  });

  if (!canView) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Film className="h-6 w-6" />}
          title={t('page.noAccessTitle')}
          description={t('page.noAccessBody')}
        />
      </div>
    );
  }

  if (statusQuery.isLoading || settingsQuery.isLoading) {
    return (
      <div className="p-6">
        <CenteredSpinner label={t('page.loading')} />
      </div>
    );
  }
  if (statusQuery.isError || settingsQuery.isError || !statusQuery.data || !settingsQuery.data) {
    return (
      <div className="p-6">
        <ErrorState
          message={t('page.error')}
          onRetry={() => {
            statusQuery.refetch();
            settingsQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/media/settings')}
          className="mb-2 -ml-2"
        >
          {t('page.backToSettings')}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Film className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
      </div>

      <ComplianceNotice />
      <ProviderStatusSection status={statusQuery.data} />
      <DatasetSection
        settings={settingsQuery.data}
        canImport={canImport}
        canConfigure={canConfigure}
      />
      <OfficialApiSection settings={settingsQuery.data} canConfigure={canConfigure} />
      <MatchingPreferencesSection settings={settingsQuery.data} canConfigure={canConfigure} />
    </div>
  );
}

function SectionCard({
  icon,
  title,
  description,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function ComplianceNotice() {
  const { t } = useTranslation('imdb');
  return (
    <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-xs text-info">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{t('complianceNotice')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// (a) Provider Status
// ---------------------------------------------------------------------------

function ProviderStatusSection({ status }: { status: ImdbStatus }) {
  const { t } = useTranslation('imdb');
  const enabled = status.source !== 'disabled';
  return (
    <SectionCard
      icon={<Activity className="h-5 w-5" />}
      title={t('status.title')}
      description={t('status.description')}
      actions={
        <Badge variant={status.available ? 'success' : enabled ? 'warning' : 'secondary'} dot>
          {status.available ? t('status.ready') : enabled ? t('status.notReady') : t('status.disabled')}
        </Badge>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatusField label={t('status.mode')} value={imdbModeLabel(t, status.source)} />
        <StatusField
          label={t('status.datasetTitles')}
          value={formatNumber(status.datasetTitleCount)}
        />
        <StatusField
          label={t('status.officialApi')}
          value={
            <Badge variant={status.apiConfigured ? 'success' : 'secondary'}>
              {status.apiConfigured ? t('status.configured') : t('status.notConfigured')}
            </Badge>
          }
        />
        <StatusField
          label={t('status.lastImport')}
          value={
            status.lastImport ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant={imdbImportStatusVariant(status.lastImport.status)}>
                  {status.lastImport.status}
                </Badge>
                <span className="text-muted-foreground">
                  {t('records', { formatted: formatNumber(status.lastImport.recordsImported) })}
                </span>
              </span>
            ) : (
              '—'
            )
          }
        />
        <StatusField
          label={t('status.lastImportAt')}
          value={
            status.lastImport?.completedAt
              ? formatRelativeTime(status.lastImport.completedAt)
              : '—'
          }
        />
        <StatusField
          label={t('status.datasetDate')}
          value={
            status.lastImport?.datasetDate ? formatDateTime(status.lastImport.datasetDate) : '—'
          }
        />
      </div>
      {status.detail && <p className="text-xs text-muted-foreground">{status.detail}</p>}
    </SectionCard>
  );
}

function StatusField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{value ?? '—'}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// (b) Dataset Configuration
// ---------------------------------------------------------------------------

function DatasetSection({
  settings,
  canImport,
  canConfigure,
}: {
  settings: ImdbSettings;
  canImport: boolean;
  canConfigure: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('imdb');

  const [datasetPath, setDatasetPath] = useState(settings.datasetPath ?? '');
  const [autoDownload, setAutoDownload] = useState(settings.autoDownloadEnabled);
  const [baseUrl, setBaseUrl] = useState(settings.datasetBaseUrl);
  const [intervalHours, setIntervalHours] = useState(String(settings.autoUpdateIntervalHours));
  const [report, setReport] = useState<ImdbDatasetValidationReport | null>(null);
  const [live, setLive] = useState<LiveImport | null>(null);

  useEffect(() => {
    setDatasetPath(settings.datasetPath ?? '');
    setAutoDownload(settings.autoDownloadEnabled);
    setBaseUrl(settings.datasetBaseUrl);
    setIntervalHours(String(settings.autoUpdateIntervalHours));
  }, [
    settings.datasetPath,
    settings.autoDownloadEnabled,
    settings.datasetBaseUrl,
    settings.autoUpdateIntervalHours,
  ]);

  // Live import progress from the media_manager.view room.
  useEffect(() => {
    const apply = (p: ImdbEventPayload, fallbackStatus: string) =>
      setLive((cur) => {
        // Ignore events for a different import once one is being tracked.
        if (cur?.importId && p.id && cur.importId !== p.id) return cur;
        return {
          importId: p.id ?? cur?.importId ?? null,
          status: p.status ?? fallbackStatus,
          progress: p.progress ?? cur?.progress ?? 0,
          message: p.message ?? cur?.message ?? null,
          recordsImported: p.recordsImported ?? cur?.recordsImported ?? 0,
          error: p.error ?? null,
        };
      });

    const offDownloadStarted = wsClient.on(WS_EVENTS.IMDB_DATASET_DOWNLOAD_STARTED, (p) =>
      apply({ ...p, progress: 0 }, 'downloading'),
    );
    const offDownloadProgress = wsClient.on(WS_EVENTS.IMDB_DATASET_DOWNLOAD_PROGRESS, (p) =>
      apply(p, 'downloading'),
    );
    const offDownloadFailed = wsClient.on(WS_EVENTS.IMDB_DATASET_DOWNLOAD_FAILED, (p) => {
      apply(p, 'failed');
      toast.error(t('dataset.downloadFailedTitle'), p.error ?? undefined);
    });
    const offProgress = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS, (p) =>
      apply(p, 'running'),
    );
    const offCompleted = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_COMPLETED, (p) => {
      apply({ ...p, progress: 100 }, 'completed');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'status'] });
      toast.success(
        t('dataset.importedToastTitle'),
        t('records', { formatted: formatNumber(p.recordsImported ?? 0) }),
      );
    });
    const offFailed = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_FAILED, (p) => {
      apply(p, 'failed');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
      toast.error(t('dataset.importFailedTitle'), p.error ?? undefined);
    });
    return () => {
      offDownloadStarted();
      offDownloadProgress();
      offDownloadFailed();
      offProgress();
      offCompleted();
      offFailed();
    };
  }, [queryClient, toast, t]);

  const importsQuery = useQuery({
    queryKey: ['media', 'imdb', 'imports'],
    queryFn: api.media.imdbImports,
  });

  const saveAuto = useMutation({
    mutationFn: (body: ImdbSettingsInput) => api.media.updateImdbSettings(body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
    },
    onError: (err) => toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  const updateNow = useMutation({
    mutationFn: () => api.media.updateImdbDatasetNow(),
    onSuccess: () => {
      setLive({
        importId: null,
        status: 'downloading',
        progress: 0,
        message: null,
        recordsImported: 0,
        error: null,
      });
      toast.success(t('dataset.updateNowStartedTitle'), t('dataset.updateNowStartedBody'));
    },
    onError: (err) =>
      toast.error(t('dataset.updateNowFailedTitle'), err instanceof ApiError ? err.message : undefined),
  });

  const validate = useMutation({
    mutationFn: () => api.media.validateImdbDataset({ datasetPath: datasetPath.trim() }),
    onSuccess: (res) => {
      setReport(res);
      if (res.valid) toast.success(t('dataset.validTitle'), t('filesFound', { count: res.filesFound }));
      else
        toast.error(
          t('dataset.invalidTitle'),
          res.hasMinimum ? undefined : t('dataset.titleBasicsMissing'),
        );
    },
    onError: (err) => toast.error(t('dataset.validationFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const startImport = useMutation({
    mutationFn: () => api.media.importImdbDataset({ datasetPath: datasetPath.trim() }),
    onSuccess: (rec) => {
      setLive({
        importId: rec.id,
        status: rec.status,
        progress: 0,
        message: null,
        recordsImported: rec.recordsImported,
        error: null,
      });
      toast.success(t('dataset.importStartedTitle'), t('dataset.importStartedBody'));
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
    },
    onError: (err) => toast.error(t('dataset.importStartError'), err instanceof ApiError ? err.message : undefined),
  });

  const importInFlight =
    startImport.isPending ||
    (live != null && live.status !== 'completed' && live.status !== 'failed');

  return (
    <SectionCard
      icon={<Database className="h-5 w-5" />}
      title={t('dataset.title')}
      description={t('dataset.description')}
    >
      <div>
        <Label htmlFor="imdb-dataset-path">{t('dataset.dirLabel')}</Label>
        <PathPicker
          id="imdb-dataset-path"
          value={datasetPath}
          onChange={setDatasetPath}
          mode="directory"
          disabled={!canImport}
          placeholder={t('dataset.dirPlaceholder')}
          pickerTitle={t('dataset.dirPicker')}
          aria-label={t('dataset.dirAria')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => validate.mutate()}
          loading={validate.isPending}
          disabled={!canImport || !datasetPath.trim()}
        >
          {t('dataset.validateBtn')}
        </Button>
        <Button
          onClick={() => startImport.mutate()}
          loading={startImport.isPending}
          disabled={!canImport || !datasetPath.trim() || importInFlight}
        >
          <Upload className="h-4 w-4" /> {t('dataset.importBtn')}
        </Button>
      </div>

      {report && <ValidationReport report={report} />}

      {live && (
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={imdbImportStatusVariant(live.status)} dot>
                {live.status}
              </Badge>
              {live.message && (
                <span className="text-xs text-muted-foreground">
                  {imdbDatasetFileLabel(t, live.message)}
                </span>
              )}
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('records', { formatted: formatNumber(live.recordsImported) })}
            </span>
          </div>
          <Progress value={live.progress / 100} showLabel />
          {live.error && <p className="text-xs text-destructive">{live.error}</p>}
        </div>
      )}

      {/* Automatic download + import */}
      <div className="space-y-3 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <div>
            <Label htmlFor="imdb-auto-toggle">{t('dataset.autoTitle')}</Label>
            <p className="text-xs text-muted-foreground">{t('dataset.autoDesc')}</p>
          </div>
          <Switch
            id="imdb-auto-toggle"
            checked={autoDownload}
            onCheckedChange={setAutoDownload}
            disabled={!canConfigure}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr,auto]">
          <div>
            <Label htmlFor="imdb-base-url">{t('dataset.baseUrlLabel')}</Label>
            <Input
              id="imdb-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('dataset.baseUrlPlaceholder')}
              disabled={!canConfigure}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('dataset.baseUrlHelp')}</p>
          </div>
          <div>
            <Label htmlFor="imdb-interval">{t('dataset.intervalLabel')}</Label>
            <Input
              id="imdb-interval"
              type="number"
              min={1}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
              className="sm:w-32"
              disabled={!canConfigure}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('dataset.intervalHelp')}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {canImport && (
            <Button
              variant="outline"
              onClick={() => updateNow.mutate()}
              loading={updateNow.isPending}
              disabled={!datasetPath.trim() || importInFlight}
            >
              <DownloadCloud className="h-4 w-4" /> {t('dataset.updateNowBtn')}
            </Button>
          )}
          {canConfigure && (
            <Button
              variant="secondary"
              onClick={() =>
                saveAuto.mutate({
                  autoDownloadEnabled: autoDownload,
                  datasetBaseUrl: baseUrl.trim() || null,
                  autoUpdateIntervalHours: Math.max(1, Number(intervalHours) || 1),
                })
              }
              loading={saveAuto.isPending}
            >
              <Save className="h-4 w-4" /> {t('dataset.saveAutoBtn')}
            </Button>
          )}
        </div>
      </div>

      {/* Import history */}
      <div className="space-y-2 border-t border-border/60 pt-4">
        <p className="text-sm font-semibold">{t('dataset.historyTitle')}</p>
        {importsQuery.isLoading ? (
          <CenteredSpinner label={t('dataset.historyLoading')} />
        ) : importsQuery.isError ? (
          <ErrorState message={t('dataset.historyError')} onRetry={() => importsQuery.refetch()} />
        ) : (importsQuery.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Database className="h-6 w-6" />}
            title={t('dataset.historyEmptyTitle')}
            description={t('dataset.historyEmptyBody')}
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] pl-4">{t('dataset.col.status')}</TableHead>
                  <TableHead className="w-[120px]">{t('dataset.col.records')}</TableHead>
                  <TableHead className="w-[160px]">{t('dataset.col.started')}</TableHead>
                  <TableHead className="w-[160px]">{t('dataset.col.finished')}</TableHead>
                  <TableHead className="min-w-[220px] pr-4">{t('dataset.col.source')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {importsQuery.data!.map((imp) => (
                  <TableRow key={imp.id}>
                    <TableCell className="pl-4">
                      <Badge variant={imdbImportStatusVariant(imp.status)} dot>
                        {imp.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatNumber(imp.recordsImported)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {imp.startedAt ? formatRelativeTime(imp.startedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {imp.completedAt
                        ? formatRelativeTime(imp.completedAt)
                        : imp.failedAt
                          ? formatRelativeTime(imp.failedAt)
                          : '—'}
                    </TableCell>
                    <TableCell className="pr-4">
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {imp.sourcePath}
                      </p>
                      {imp.errorMessage && (
                        <p className="truncate text-xs text-destructive">{imp.errorMessage}</p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function ValidationReport({ report }: { report: ImdbDatasetValidationReport }) {
  const { t } = useTranslation('imdb');
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={report.valid ? 'success' : 'destructive'} dot>
          {report.valid ? t('report.valid') : t('report.invalid')}
        </Badge>
        <span className="text-xs text-muted-foreground">{t('filesFound', { count: report.filesFound })}</span>
        {!report.hasMinimum && (
          <Badge variant="warning">{t('report.titleBasicsMissingBadge')}</Badge>
        )}
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px] pl-3">{t('report.col.file')}</TableHead>
              <TableHead className="w-[90px]">{t('report.col.present')}</TableHead>
              <TableHead className="w-[90px]">{t('report.col.header')}</TableHead>
              <TableHead className="w-[100px] pr-3">{t('report.col.size')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.files.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="pl-3">
                  <span className="text-sm">{imdbDatasetFileLabel(t, f.key)}</span>
                  <p className="font-mono text-[11px] text-muted-foreground">{f.file}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={f.present ? 'success' : 'secondary'}>
                    {f.present ? t('report.yes') : t('report.no')}
                  </Badge>
                </TableCell>
                <TableCell>
                  {f.present ? (
                    <Badge variant={f.headerOk ? 'success' : 'destructive'}>
                      {f.headerOk ? t('report.ok') : t('report.bad')}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="pr-3 tabular-nums text-muted-foreground">
                  {f.sizeBytes != null ? formatBytes(f.sizeBytes) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// (c) Official API Configuration
// ---------------------------------------------------------------------------

function OfficialApiSection({
  settings,
  canConfigure,
}: {
  settings: ImdbSettings;
  canConfigure: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('imdb');

  const [mode, setMode] = useState(settings.mode);
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl ?? '');
  const [apiKey, setApiKey] = useState(settings.hasApiKey ? REDACTED : '');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [cacheTtl, setCacheTtl] = useState(String(settings.cacheTtl));

  useEffect(() => {
    setMode(settings.mode);
    setApiBaseUrl(settings.apiBaseUrl ?? '');
    setApiKey(settings.hasApiKey ? REDACTED : '');
    setApiKeyDirty(false);
    setCacheTtl(String(settings.cacheTtl));
  }, [settings.mode, settings.apiBaseUrl, settings.hasApiKey, settings.cacheTtl]);

  const save = useMutation({
    mutationFn: () => {
      const body: ImdbSettingsInput = {
        mode,
        apiBaseUrl: apiBaseUrl.trim() || null,
        cacheTtl: Number(cacheTtl) || 0,
      };
      // Only send the key when the user actually changed it (write-only field).
      if (apiKeyDirty) body.apiKey = apiKey.trim() || null;
      return api.media.updateImdbSettings(body);
    },
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'status'] });
    },
    onError: (err) => toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  const test = useMutation({
    mutationFn: () => api.media.testImdbApi(),
    onSuccess: (res) => {
      if (res.available) toast.success(t('api.connOkTitle'), t('api.connOkBody'));
      else if (res.apiConfigured)
        toast.error(t('api.configuredUnavailableTitle'), t('api.configuredUnavailableBody'));
      else toast.error(t('api.notConfiguredTitle'), t('api.notConfiguredBody'));
    },
    onError: (err) => toast.error(t('api.testFailed'), err instanceof ApiError ? err.message : undefined),
  });

  return (
    <SectionCard
      icon={<Plug className="h-5 w-5" />}
      title={t('api.title')}
      description={t('api.description')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="imdb-mode">{t('api.mode')}</Label>
          <Select
            id="imdb-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            options={imdbModeOptions(t)}
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-base-url">{t('api.baseUrl')}</Label>
          <Input
            id="imdb-base-url"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder={t('api.baseUrlPlaceholder')}
            disabled={!canConfigure}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="imdb-api-key">{t('api.apiKey')}</Label>
          <Input
            id="imdb-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setApiKeyDirty(true);
            }}
            onFocus={() => {
              if (!apiKeyDirty && apiKey === REDACTED) {
                setApiKey('');
                setApiKeyDirty(true);
              }
            }}
            placeholder={settings.hasApiKey ? t('api.apiKeyPlaceholderKeep') : t('api.apiKeyPlaceholderNew')}
            disabled={!canConfigure}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="imdb-cache-ttl">{t('api.cacheTtl')}</Label>
          <Input
            id="imdb-cache-ttl"
            type="number"
            min={0}
            value={cacheTtl}
            onChange={(e) => setCacheTtl(e.target.value)}
            disabled={!canConfigure}
          />
        </div>
      </div>

      {canConfigure && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
          <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
            {t('api.testBtn')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            <Save className="h-4 w-4" /> {t('api.saveBtn')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// (d) Matching Preferences
// ---------------------------------------------------------------------------

function MatchingPreferencesSection({
  settings,
  canConfigure,
}: {
  settings: ImdbSettings;
  canConfigure: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('imdb');

  const [language, setLanguage] = useState(settings.preferredLanguage ?? '');
  const [region, setRegion] = useState(settings.preferredRegion ?? '');
  const [includeAdult, setIncludeAdult] = useState(settings.includeAdult);
  const [minVotes, setMinVotes] = useState(String(settings.minVotes));

  useEffect(() => {
    setLanguage(settings.preferredLanguage ?? '');
    setRegion(settings.preferredRegion ?? '');
    setIncludeAdult(settings.includeAdult);
    setMinVotes(String(settings.minVotes));
  }, [settings.preferredLanguage, settings.preferredRegion, settings.includeAdult, settings.minVotes]);

  const save = useMutation({
    mutationFn: () =>
      api.media.updateImdbSettings({
        preferredLanguage: language.trim() || null,
        preferredRegion: region.trim() || null,
        includeAdult,
        minVotes: Number(minVotes) || 0,
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
    },
    onError: (err) => toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  return (
    <SectionCard
      icon={<SlidersHorizontal className="h-5 w-5" />}
      title={t('matching.title')}
      description={t('matching.description')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="imdb-language">{t('matching.language')}</Label>
          <Input
            id="imdb-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder={t('matching.languagePlaceholder')}
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-region">{t('matching.region')}</Label>
          <Input
            id="imdb-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder={t('matching.regionPlaceholder')}
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-min-votes">{t('matching.minVotes')}</Label>
          <Input
            id="imdb-min-votes"
            type="number"
            min={0}
            value={minVotes}
            onChange={(e) => setMinVotes(e.target.value)}
            placeholder={t('matching.minVotesPlaceholder')}
            disabled={!canConfigure}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('matching.minVotesHint')}</p>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <div>
            <Label htmlFor="imdb-adult">{t('matching.includeAdult')}</Label>
            <p className="text-xs text-muted-foreground">{t('matching.includeAdultHint')}</p>
          </div>
          <Switch
            id="imdb-adult"
            checked={includeAdult}
            onCheckedChange={setIncludeAdult}
            disabled={!canConfigure}
          />
        </div>
      </div>

      {canConfigure && (
        <div className="flex justify-end border-t border-border/60 pt-4">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            <Save className="h-4 w-4" /> {t('matching.saveBtn')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
