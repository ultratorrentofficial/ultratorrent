import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
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
  LIBRARY_KIND_OPTIONS,
  MODE_OPTIONS,
  PRESET_OPTIONS,
  kindLabel,
  modeLabel,
  presetLabel,
} from './constants';

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
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_LIBRARIES);
  const canScan = hasPermission(PERMISSIONS.MEDIA_MANAGER_SCAN);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MediaLibrary | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);

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
    try {
      const res = await api.media.scanLibrary(lib.id);
      toast.success(
        `Scanned “${lib.name}”`,
        `${res.scanned} scanned · ${res.added} added · ${res.updated} updated.`,
      );
      invalidate();
    } catch (err) {
      toast.error('Scan failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setScanningId(null);
    }
  };

  const remove = async (lib: MediaLibrary) => {
    if (!confirm(`Delete library "${lib.name}"? Scanned items for this library are removed too.`)) return;
    try {
      await api.media.deleteLibrary(lib.id);
      toast.success('Library deleted', lib.name);
      invalidate();
    } catch (err) {
      toast.error('Could not delete library', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
            Media Manager
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Libraries</h1>
          <p className="text-sm text-muted-foreground">
            Point Media Manager at folders to scan, identify, and organise. Each library carries its
            own preset and naming template.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <FolderTree className="h-4 w-4" /> Add library
          </Button>
        )}
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading libraries…" />
      ) : isError ? (
        <ErrorState message="Could not load libraries." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FolderTree className="h-6 w-6" />}
              title="No libraries"
              description="Define a library to map a media kind to a folder and naming template."
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <FolderTree className="h-4 w-4" /> Add your first library
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
                      <Badge variant="secondary">{kindLabel(lib.kind)}</Badge>
                      <Badge variant="info">{presetLabel(lib.preset)}</Badge>
                      <Badge variant="outline">{modeLabel(lib.mode)}</Badge>
                      {!lib.isEnabled && <Badge variant="warning">disabled</Badge>}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{lib.path}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {count !== undefined && <span>{count.toLocaleString()} item{count === 1 ? '' : 's'}</span>}
                      <span>
                        {lib.lastScanAt ? `Scanned ${formatRelativeTime(lib.lastScanAt)}` : 'Never scanned'}
                      </span>
                      {lib.scanIntervalMinutes != null && <span>Auto-scan every {lib.scanIntervalMinutes} min</span>}
                      {lib.nfoEnabled && <span>NFO</span>}
                      {lib.artworkEnabled && <span>Artwork</span>}
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
                        <RefreshCw className="h-4 w-4" /> Scan
                      </Button>
                    )}
                    {canManage && (
                      <>
                        <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(lib)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void remove(lib)}>
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
      toast.error('Invalid scan interval', 'Enter a non-negative number of minutes, or leave it blank.');
      return;
    }
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
      toast.success(library ? 'Library updated' : 'Library created', body.name);
      onSaved();
    } catch (err) {
      toast.error('Could not save library', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{library ? 'Edit library' : 'Add library'}</DialogTitle>
        <DialogDescription>
          Maps a media kind to a folder, naming template, and scan schedule.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="lib-name">Name</Label>
          <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TV Shows" />
        </div>
        <div>
          <Label htmlFor="lib-path">Library path</Label>
          <PathPicker id="lib-path" value={path} onChange={setPath} placeholder="/media/tv" aria-label="Library path" pickerTitle="Choose a library folder" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="lib-kind">Kind</Label>
            <Select id="lib-kind" value={kind} onChange={(e) => setKind(e.target.value as MediaKind)} options={LIBRARY_KIND_OPTIONS} />
          </div>
          <div>
            <Label htmlFor="lib-preset">Preset</Label>
            <Select id="lib-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={PRESET_OPTIONS} />
          </div>
          <div>
            <Label htmlFor="lib-mode">Mode</Label>
            <Select id="lib-mode" value={mode} onChange={(e) => setMode(e.target.value as RenameMode)} options={MODE_OPTIONS} />
          </div>
        </div>
        <div>
          <Label htmlFor="lib-template">Template (optional)</Label>
          <Textarea
            id="lib-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={defaultTemplate || 'Leave empty to use the preset default'}
            className="font-mono text-xs"
          />
          {defaultTemplate && (
            <p className="mt-1 text-xs text-muted-foreground">
              Preset default: <code className="font-mono">{defaultTemplate}</code>
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="lib-scan-interval">Auto-scan interval (minutes)</Label>
          <Input
            id="lib-scan-interval"
            type="number"
            min={0}
            value={scanInterval}
            onChange={(e) => setScanInterval(e.target.value)}
            placeholder="Leave blank to scan manually"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="lib-nfo">Generate NFO</Label>
            <Switch id="lib-nfo" checked={nfoEnabled} onCheckedChange={setNfoEnabled} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="lib-artwork">Fetch artwork</Label>
            <Switch id="lib-artwork" checked={artworkEnabled} onCheckedChange={setArtworkEnabled} />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="lib-enabled">Enabled</Label>
          <Switch id="lib-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} loading={saving} disabled={!name.trim() || !path.trim()}>
          {library ? 'Save changes' : 'Add library'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
