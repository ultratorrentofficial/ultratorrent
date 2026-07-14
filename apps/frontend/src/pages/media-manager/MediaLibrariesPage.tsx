import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import {
  ApiError,
  api,
  type CreateLibraryInput,
  type MediaKind,
  type MediaLibrary,
  type MediaPresets,
  type Preset,
  type RenameMode,
} from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS, WS_EVENTS, type MediaJobEventPayload } from '@ultratorrent/shared';
import { wsClient } from '@/lib/ws';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { RenameTokensHelp } from '@/pages/media-renamer/RenameTokensHelp';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import {
  kindLabel,
  libraryKindOptions,
  modeLabel,
  modeOptions,
  presetLabel,
  presetOptions,
} from './constants';

interface ScanLive {
  libraryId: string;
  name: string;
  progress: number;
  status: 'running' | 'completed' | 'failed';
  log: string[];
  error?: string | null;
}

function presetTemplate(
  presets: MediaPresets | undefined,
  preset: Preset,
  kind: MediaKind,
): string {
  if (!presets || preset === 'custom') return '';
  const group = presets[preset as Exclude<Preset, 'custom'>];
  return group?.[kind] ?? '';
}

export function MediaLibrariesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_LIBRARIES);
  const canScan = hasPermission(PERMISSIONS.MEDIA_MANAGER_SCAN);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MediaLibrary | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [scanLive, setScanLive] = useState<ScanLive | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [scanLive?.log.length]);

  // Live scan progress + action log, streamed over the media_manager.job WS
  // events. Only events for the library currently being scanned update the panel.
  useEffect(() => {
    const apply = (p: MediaJobEventPayload, status?: ScanLive['status']) =>
      setScanLive((cur) => {
        if (!cur || p.type !== 'library_scan' || p.libraryId !== cur.libraryId) return cur;
        return {
          ...cur,
          progress: typeof p.progress === 'number' ? p.progress : cur.progress,
          status: status ?? cur.status,
          error: p.error ?? cur.error,
          log: p.message ? [...cur.log, p.message].slice(-300) : cur.log,
        };
      });
    const offStarted = wsClient.on(WS_EVENTS.MEDIA_JOB_STARTED, (p) => apply(p, 'running'));
    const offProgress = wsClient.on(WS_EVENTS.MEDIA_JOB_PROGRESS, (p) => apply(p));
    const offCompleted = wsClient.on(WS_EVENTS.MEDIA_JOB_COMPLETED, (p) => {
      apply({ ...p, progress: 100 }, 'completed');
      if (p.type === 'library_scan') {
        queryClient.invalidateQueries({ queryKey: ['media'] });
        setScanningId((cur) => (cur === p.libraryId ? null : cur));

        // The scan found two folders holding the same show. It cannot settle that on
        // its own — merging moves files and permanently deletes a folder, and only
        // the operator knows which path is the real one. So we surface it and send
        // them to the panel where they choose, preview the exact plan, and confirm.
        const dupes = (p.result as { duplicateShows?: number } | undefined)?.duplicateShows ?? 0;
        if (dupes > 0) {
          toast.info(
            t('libraries.duplicateShowsFound', { count: dupes }),
            t('libraries.duplicateShowsHint'),
          );
        }
      }
    });
    const offFailed = wsClient.on(WS_EVENTS.MEDIA_JOB_FAILED, (p) => {
      apply(p, 'failed');
      if (p.type === 'library_scan') setScanningId((cur) => (cur === p.libraryId ? null : cur));
    });
    return () => {
      offStarted();
      offProgress();
      offCompleted();
      offFailed();
    };
    // `toast`/`t` are closed over by the completed handler. Both are stable, so this
    // re-subscribes only on a language change, which is harmless.
  }, [toast, t]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: api.media.listLibraries,
  });

  const counts = useQuery({
    queryKey: ['media', 'dashboard'],
    queryFn: api.media.dashboard,
  });
  const itemCountFor = (id: string) =>
    counts.data?.libraries.find((l) => l.id === id)?.itemCount;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media'] });

  const scan = async (lib: MediaLibrary) => {
    setScanningId(lib.id);
    setScanLive({ libraryId: lib.id, name: lib.name, progress: 0, status: 'running', log: [], error: null });
    try {
      // Fire-and-forget: the endpoint returns a jobId immediately (no gateway
      // timeout on huge libraries). Progress + completion arrive over the WS
      // events, which drive the live panel and clear the spinner.
      await api.media.scanLibrary(lib.id);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : undefined;
      setScanLive((cur) =>
        cur && cur.libraryId === lib.id ? { ...cur, status: 'failed', error: msg ?? 'error' } : cur,
      );
      setScanningId((cur) => (cur === lib.id ? null : cur));
      toast.error(t('libraries.scanFailed'), msg);
    }
  };

  const remove = async (lib: MediaLibrary) => {
    if (!confirm(t('libraries.deleteConfirm', { name: lib.name }))) return;
    try {
      await api.media.deleteLibrary(lib.id);
      toast.success(t('libraries.deletedTitle'), lib.name);
      invalidate();
    } catch (err) {
      toast.error(t('libraries.deleteError'), err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
            {t('common.backToManager')}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{t('libraries.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('libraries.subtitle')}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <FolderTree className="h-4 w-4" /> {t('libraries.addLibrary')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <CenteredSpinner label={t('libraries.loading')} />
      ) : isError ? (
        <ErrorState message={t('libraries.error')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FolderTree className="h-6 w-6" />}
              title={t('libraries.emptyTitle')}
              description={t('libraries.emptyBody')}
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <FolderTree className="h-4 w-4" /> {t('libraries.addFirst')}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((lib) => {
            const count = itemCountFor(lib.id);
            return (
              <Card key={lib.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{lib.name}</p>
                      <Badge variant="secondary">{kindLabel(t, lib.kind)}</Badge>
                      <Badge variant="info">{presetLabel(t, lib.preset)}</Badge>
                      <Badge variant="outline">{modeLabel(t, lib.mode)}</Badge>
                      {!lib.isEnabled && <Badge variant="warning">{t('common.disabledBadge')}</Badge>}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{lib.path}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {count !== undefined && <span>{t('common.items', { count })}</span>}
                      <span>
                        {lib.lastScanAt
                          ? t('common.scannedAgo', { time: formatRelativeTime(lib.lastScanAt) })
                          : t('common.neverScanned')}
                      </span>
                      {lib.scanIntervalMinutes != null && (
                        <span>{t('libraries.autoScanEvery', { minutes: lib.scanIntervalMinutes })}</span>
                      )}
                      {lib.nfoEnabled && <span>{t('libraries.nfo')}</span>}
                      {lib.artworkEnabled && <span>{t('libraries.artwork')}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canScan && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void scan(lib)}
                        loading={scanningId === lib.id}
                        disabled={scanningId !== null}
                      >
                        <RefreshCw className="h-4 w-4" /> {t('libraries.scan')}
                      </Button>
                    )}
                    {canManage && (
                      <>
                        <Button variant="ghost" size="icon" aria-label={t('libraries.editAria')} onClick={() => setEditing(lib)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={t('libraries.deleteAria')} onClick={() => void remove(lib)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <LibraryDialog
          library={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            invalidate();
          }}
        />
      )}

      {scanLive && (
        <Dialog open onClose={() => setScanLive(null)} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('libraries.scanProgress.title', { name: scanLive.name })}</DialogTitle>
            <DialogDescription>
              {scanLive.status === 'running'
                ? t('libraries.scanProgress.running')
                : scanLive.status === 'completed'
                  ? t('libraries.scanProgress.done')
                  : t('libraries.scanProgress.failed')}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{t('libraries.scanProgress.progressLabel')}</span>
              <span>{Math.round(scanLive.progress)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className={`h-full transition-all ${scanLive.status === 'failed' ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: `${Math.min(100, Math.max(0, scanLive.progress))}%` }}
              />
            </div>
          </div>

          <div
            ref={logRef}
            className="mt-3 h-64 overflow-y-auto rounded border border-border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
          >
            {scanLive.log.length === 0 ? (
              <div className="text-muted-foreground">{t('libraries.scanProgress.waiting')}</div>
            ) : (
              scanLive.log.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))
            )}
            {scanLive.error && <div className="text-destructive">{scanLive.error}</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setScanLive(null)}>
              {scanLive.status === 'running'
                ? t('libraries.scanProgress.hide')
                : t('libraries.scanProgress.close')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function LibraryDialog({
  library,
  onClose,
  onSaved,
}: {
  library: MediaLibrary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation('media');
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const { data: presets } = useQuery({ queryKey: ['media', 'presets'], queryFn: api.media.presets });
  const [name, setName] = useState(library?.name ?? '');
  const [path, setPath] = useState(library?.path ?? '');
  const [kind, setKind] = useState<MediaKind>(library?.kind ?? 'tv');
  const [preset, setPreset] = useState<Preset>(library?.preset ?? 'plex');
  const [mode, setMode] = useState<RenameMode>(library?.mode ?? 'hardlink');
  const [template, setTemplate] = useState(library?.template ?? '');
  const [scanInterval, setScanInterval] = useState(
    library?.scanIntervalMinutes != null ? String(library.scanIntervalMinutes) : '',
  );
  const [nfoEnabled, setNfoEnabled] = useState(library?.nfoEnabled ?? false);
  const [artworkEnabled, setArtworkEnabled] = useState(library?.artworkEnabled ?? true);
  const [enabled, setEnabled] = useState(library?.isEnabled ?? true);
  const [saving, setSaving] = useState(false);

  const defaultTemplate = presetTemplate(presets, preset, kind);

  const submit = async () => {
    const trimmedInterval = scanInterval.trim();
    const parsedInterval = trimmedInterval === '' ? null : Number(trimmedInterval);
    if (parsedInterval != null && (!Number.isFinite(parsedInterval) || parsedInterval < 0)) {
      toast.error(t('libraries.invalidIntervalTitle'), t('libraries.invalidIntervalBody'));
      return;
    }
    // Validate the path against the hard roots and offer to create it if missing.
    if (!(await ensureDirectory(path))) return;
    setSaving(true);
    try {
      const body: CreateLibraryInput = {
        name: name.trim(),
        path: path.trim(),
        kind,
        preset,
        mode,
        template: template.trim() || undefined,
        isEnabled: enabled,
        scanIntervalMinutes: parsedInterval,
        nfoEnabled,
        artworkEnabled,
      };
      if (library) await api.media.updateLibrary(library.id, body);
      else await api.media.createLibrary(body);
      toast.success(library ? t('libraries.updatedTitle') : t('libraries.createdTitle'), body.name);
      onSaved();
    } catch (err) {
      toast.error(t('libraries.saveError'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{library ? t('libraries.dialog.editTitle') : t('libraries.dialog.addTitle')}</DialogTitle>
        <DialogDescription>
          {t('libraries.dialog.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="lib-name">{t('libraries.field.name')}</Label>
          <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('libraries.field.namePlaceholder')} />
        </div>
        <div>
          <Label htmlFor="lib-path">{t('libraries.field.path')}</Label>
          <PathPicker id="lib-path" value={path} onChange={setPath} placeholder={t('libraries.field.pathPlaceholder')} aria-label={t('libraries.field.pathAria')} pickerTitle={t('libraries.field.pathPicker')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="lib-kind">{t('libraries.field.kind')}</Label>
            <Select id="lib-kind" value={kind} onChange={(e) => setKind(e.target.value as MediaKind)} options={libraryKindOptions(t)} />
          </div>
          <div>
            <Label htmlFor="lib-preset">{t('libraries.field.preset')}</Label>
            <Select id="lib-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={presetOptions(t)} />
          </div>
          <div>
            <Label htmlFor="lib-mode">{t('libraries.field.mode')}</Label>
            <Select id="lib-mode" value={mode} onChange={(e) => setMode(e.target.value as RenameMode)} options={modeOptions(t)} />
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5"><Label htmlFor="lib-template">{t('libraries.field.template')}</Label><RenameTokensHelp /></div>
          <Textarea
            id="lib-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={defaultTemplate || t('libraries.field.templatePlaceholder')}
            className="font-mono text-xs"
          />
          {defaultTemplate && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('libraries.presetDefault')} <code className="font-mono">{defaultTemplate}</code>
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="lib-scan-interval">{t('libraries.field.scanInterval')}</Label>
          <Input
            id="lib-scan-interval"
            type="number"
            min={0}
            value={scanInterval}
            onChange={(e) => setScanInterval(e.target.value)}
            placeholder={t('libraries.field.scanIntervalPlaceholder')}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="lib-nfo">{t('libraries.field.nfo')}</Label>
            <Switch id="lib-nfo" checked={nfoEnabled} onCheckedChange={setNfoEnabled} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="lib-artwork">{t('libraries.field.artwork')}</Label>
            <Switch id="lib-artwork" checked={artworkEnabled} onCheckedChange={setArtworkEnabled} />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="lib-enabled">{t('libraries.field.enabled')}</Label>
          <Switch id="lib-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void submit()} loading={saving} disabled={!name.trim() || !path.trim()}>
          {library ? t('common.saveChanges') : t('libraries.addLibrary')}
        </Button>
      </DialogFooter>
    </Dialog>
    {ensureDirectoryDialog}
    </>
  );
}
