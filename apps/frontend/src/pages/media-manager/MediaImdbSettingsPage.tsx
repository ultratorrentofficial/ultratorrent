import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS, type ImdbEventPayload } from '@ultratorrent/shared';
import {
  Activity,
  Database,
  Film,
  Plug,
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
  IMDB_COMPLIANCE_NOTICE,
  IMDB_MODE_OPTIONS,
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
          title="No access"
          description="You do not have permission to view the IMDb provider."
        />
      </div>
    );
  }

  if (statusQuery.isLoading || settingsQuery.isLoading) {
    return (
      <div className="p-6">
        <CenteredSpinner label="Loading IMDb settings…" />
      </div>
    );
  }
  if (statusQuery.isError || settingsQuery.isError || !statusQuery.data || !settingsQuery.data) {
    return (
      <div className="p-6">
        <ErrorState
          message="Could not load IMDb provider settings."
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
          Media Settings
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Film className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">IMDb Provider</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure IMDb metadata from user-provided datasets or a licensed IMDb API.
        </p>
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
  return (
    <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-xs text-info">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{IMDB_COMPLIANCE_NOTICE}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// (a) Provider Status
// ---------------------------------------------------------------------------

function ProviderStatusSection({ status }: { status: ImdbStatus }) {
  const enabled = status.source !== 'disabled';
  return (
    <SectionCard
      icon={<Activity className="h-5 w-5" />}
      title="Provider status"
      description="Current IMDb provider health and last dataset import."
      actions={
        <Badge variant={status.available ? 'success' : enabled ? 'warning' : 'secondary'} dot>
          {status.available ? 'Ready' : enabled ? 'Not ready' : 'Disabled'}
        </Badge>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatusField label="Mode" value={imdbModeLabel(status.source)} />
        <StatusField
          label="Dataset titles"
          value={formatNumber(status.datasetTitleCount)}
        />
        <StatusField
          label="Official API"
          value={
            <Badge variant={status.apiConfigured ? 'success' : 'secondary'}>
              {status.apiConfigured ? 'Configured' : 'Not configured'}
            </Badge>
          }
        />
        <StatusField
          label="Last import"
          value={
            status.lastImport ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant={imdbImportStatusVariant(status.lastImport.status)}>
                  {status.lastImport.status}
                </Badge>
                <span className="text-muted-foreground">
                  {formatNumber(status.lastImport.recordsImported)} records
                </span>
              </span>
            ) : (
              '—'
            )
          }
        />
        <StatusField
          label="Last import at"
          value={
            status.lastImport?.completedAt
              ? formatRelativeTime(status.lastImport.completedAt)
              : '—'
          }
        />
        <StatusField
          label="Dataset date"
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

  const [datasetPath, setDatasetPath] = useState(settings.datasetPath ?? '');
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(settings.importSchedule));
  const [schedule, setSchedule] = useState(settings.importSchedule ?? '');
  const [report, setReport] = useState<ImdbDatasetValidationReport | null>(null);
  const [live, setLive] = useState<LiveImport | null>(null);

  useEffect(() => {
    setDatasetPath(settings.datasetPath ?? '');
    setScheduleEnabled(Boolean(settings.importSchedule));
    setSchedule(settings.importSchedule ?? '');
  }, [settings.datasetPath, settings.importSchedule]);

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

    const offProgress = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS, (p) =>
      apply(p, 'running'),
    );
    const offCompleted = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_COMPLETED, (p) => {
      apply({ ...p, progress: 100 }, 'completed');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'status'] });
      toast.success('IMDb dataset imported', `${formatNumber(p.recordsImported ?? 0)} records`);
    });
    const offFailed = wsClient.on(WS_EVENTS.IMDB_DATASET_IMPORT_FAILED, (p) => {
      apply(p, 'failed');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
      toast.error('IMDb import failed', p.error ?? undefined);
    });
    return () => {
      offProgress();
      offCompleted();
      offFailed();
    };
  }, [queryClient, toast]);

  const importsQuery = useQuery({
    queryKey: ['media', 'imdb', 'imports'],
    queryFn: api.media.imdbImports,
  });

  const saveSchedule = useMutation({
    mutationFn: (body: ImdbSettingsInput) => api.media.updateImdbSettings(body),
    onSuccess: () => {
      toast.success('Saved');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  });

  const validate = useMutation({
    mutationFn: () => api.media.validateImdbDataset({ datasetPath: datasetPath.trim() }),
    onSuccess: (res) => {
      setReport(res);
      if (res.valid) toast.success('Dataset looks valid', `${res.filesFound} file(s) found`);
      else toast.error('Dataset validation failed', res.hasMinimum ? undefined : 'title.basics missing');
    },
    onError: (err) => toast.error('Validation failed', err instanceof ApiError ? err.message : undefined),
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
      toast.success('Import started', 'Live progress will appear below.');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'imports'] });
    },
    onError: (err) => toast.error('Could not start import', err instanceof ApiError ? err.message : undefined),
  });

  const importInFlight =
    startImport.isPending ||
    (live != null && live.status !== 'completed' && live.status !== 'failed');

  return (
    <SectionCard
      icon={<Database className="h-5 w-5" />}
      title="Dataset configuration"
      description="Point to a directory holding the official IMDb TSV dataset files (.tsv.gz)."
    >
      <div>
        <Label htmlFor="imdb-dataset-path">Dataset directory</Label>
        <PathPicker
          id="imdb-dataset-path"
          value={datasetPath}
          onChange={setDatasetPath}
          mode="directory"
          disabled={!canImport}
          placeholder="/data/imdb"
          pickerTitle="Select the IMDb dataset directory"
          aria-label="IMDb dataset directory"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => validate.mutate()}
          loading={validate.isPending}
          disabled={!canImport || !datasetPath.trim()}
        >
          Validate dataset
        </Button>
        <Button
          onClick={() => startImport.mutate()}
          loading={startImport.isPending}
          disabled={!canImport || !datasetPath.trim() || importInFlight}
        >
          <Upload className="h-4 w-4" /> Import now
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
                  {imdbDatasetFileLabel(live.message)}
                </span>
              )}
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatNumber(live.recordsImported)} records
            </span>
          </div>
          <Progress value={live.progress / 100} showLabel />
          {live.error && <p className="text-xs text-destructive">{live.error}</p>}
        </div>
      )}

      {/* Scheduled import */}
      <div className="space-y-3 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <div>
            <Label htmlFor="imdb-schedule-toggle">Scheduled import</Label>
            <p className="text-xs text-muted-foreground">
              Automatically re-import on a cron schedule.
            </p>
          </div>
          <Switch
            id="imdb-schedule-toggle"
            checked={scheduleEnabled}
            onCheckedChange={setScheduleEnabled}
            disabled={!canConfigure}
          />
        </div>
        {scheduleEnabled && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1">
              <Label htmlFor="imdb-schedule">Cron schedule</Label>
              <Input
                id="imdb-schedule"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 4 * * 0"
                disabled={!canConfigure}
              />
            </div>
          </div>
        )}
        {canConfigure && (
          <div className="flex justify-end">
            <Button
              variant="secondary"
              onClick={() =>
                saveSchedule.mutate({
                  importSchedule: scheduleEnabled ? schedule.trim() || null : null,
                })
              }
              loading={saveSchedule.isPending}
            >
              <Save className="h-4 w-4" /> Save schedule
            </Button>
          </div>
        )}
      </div>

      {/* Import history */}
      <div className="space-y-2 border-t border-border/60 pt-4">
        <p className="text-sm font-semibold">Import history</p>
        {importsQuery.isLoading ? (
          <CenteredSpinner label="Loading imports…" />
        ) : importsQuery.isError ? (
          <ErrorState message="Could not load imports." onRetry={() => importsQuery.refetch()} />
        ) : (importsQuery.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Database className="h-6 w-6" />}
            title="No imports yet"
            description="Validate and import a dataset to populate IMDb metadata."
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] pl-4">Status</TableHead>
                  <TableHead className="w-[120px]">Records</TableHead>
                  <TableHead className="w-[160px]">Started</TableHead>
                  <TableHead className="w-[160px]">Finished</TableHead>
                  <TableHead className="min-w-[220px] pr-4">Source</TableHead>
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
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={report.valid ? 'success' : 'destructive'} dot>
          {report.valid ? 'Valid' : 'Invalid'}
        </Badge>
        <span className="text-xs text-muted-foreground">{report.filesFound} file(s) found</span>
        {!report.hasMinimum && (
          <Badge variant="warning">title.basics missing — cannot import</Badge>
        )}
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px] pl-3">File</TableHead>
              <TableHead className="w-[90px]">Present</TableHead>
              <TableHead className="w-[90px]">Header</TableHead>
              <TableHead className="w-[100px] pr-3">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.files.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="pl-3">
                  <span className="text-sm">{imdbDatasetFileLabel(f.key)}</span>
                  <p className="font-mono text-[11px] text-muted-foreground">{f.file}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={f.present ? 'success' : 'secondary'}>
                    {f.present ? 'Yes' : 'No'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {f.present ? (
                    <Badge variant={f.headerOk ? 'success' : 'destructive'}>
                      {f.headerOk ? 'OK' : 'Bad'}
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
      toast.success('Saved');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'status'] });
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  });

  const test = useMutation({
    mutationFn: () => api.media.testImdbApi(),
    onSuccess: (res) => {
      if (res.available) toast.success('Connection OK', 'IMDb API is available.');
      else if (res.apiConfigured)
        toast.error('API configured but unavailable', 'Check the base URL and key.');
      else toast.error('API not configured', 'Set a base URL and API key first.');
    },
    onError: (err) => toast.error('Test failed', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <SectionCard
      icon={<Plug className="h-5 w-5" />}
      title="Official / licensed API"
      description="Optional licensed IMDb REST API used for search and lookups. Never contacts imdb.com."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="imdb-mode">Provider mode</Label>
          <Select
            id="imdb-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            options={IMDB_MODE_OPTIONS}
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-base-url">API base URL</Label>
          <Input
            id="imdb-base-url"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://api.example.com/imdb"
            disabled={!canConfigure}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="imdb-api-key">API key</Label>
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
            placeholder={settings.hasApiKey ? 'Leave blank to keep existing' : 'Enter API key'}
            disabled={!canConfigure}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="imdb-cache-ttl">Cache TTL (seconds)</Label>
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
            Test connection
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            <Save className="h-4 w-4" /> Save
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
      toast.success('Saved');
      queryClient.invalidateQueries({ queryKey: ['media', 'imdb', 'settings'] });
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <SectionCard
      icon={<SlidersHorizontal className="h-5 w-5" />}
      title="Matching preferences"
      description="Tune how IMDb search ranks and filters candidate titles."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="imdb-language">Preferred language</Label>
          <Input
            id="imdb-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-region">Preferred region</Label>
          <Input
            id="imdb-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="US"
            disabled={!canConfigure}
          />
        </div>
        <div>
          <Label htmlFor="imdb-min-votes">Minimum votes</Label>
          <Input
            id="imdb-min-votes"
            type="number"
            min={0}
            value={minVotes}
            onChange={(e) => setMinVotes(e.target.value)}
            placeholder="0"
            disabled={!canConfigure}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Higher thresholds weight confidence toward well-known titles.
          </p>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <div>
            <Label htmlFor="imdb-adult">Include adult titles</Label>
            <p className="text-xs text-muted-foreground">Off by default.</p>
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
            <Save className="h-4 w-4" /> Save preferences
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
