import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FolderTree,
  History,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import {
  ApiError,
  api,
  type CreateLibraryInput,
  type MediaKind,
  type MediaLibrary,
  type MediaPresets,
  type Preset,
  type RenameMode,
  type RenamePlan,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { DryRunTab, JobsTab, TemplatesTab } from './media-renamer/tabs';

export const KIND_OPTIONS: { value: MediaKind; label: string }[] = [
  { value: 'tv', label: 'TV' },
  { value: 'anime', label: 'Anime' },
  { value: 'movie', label: 'Movie' },
  { value: 'music', label: 'Music' },
  { value: 'audiobook', label: 'Audiobook' },
  { value: 'general', label: 'General' },
];

export const PRESET_OPTIONS: { value: Preset; label: string }[] = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kodi', label: 'Kodi' },
  { value: 'custom', label: 'Custom' },
];

export const MODE_OPTIONS: { value: RenameMode; label: string }[] = [
  { value: 'preview', label: 'Preview only' },
  { value: 'rename_in_place', label: 'Rename in place' },
  { value: 'rename_move', label: 'Rename + move' },
  { value: 'copy', label: 'Copy' },
  { value: 'hardlink', label: 'Hardlink (keeps seeding)' },
  { value: 'symlink', label: 'Symlink (keeps seeding)' },
];

function presetTemplate(
  presets: MediaPresets | undefined,
  preset: Preset,
  kind: MediaKind,
): string {
  if (!presets || preset === 'custom') return '';
  const group = presets[preset as Exclude<Preset, 'custom'>];
  return group?.[kind] ?? '';
}

export function MediaPage() {
  const [tab, setTab] = useState('libraries');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Media renamer</h1>
        <p className="text-sm text-muted-foreground">
          Organize downloads into media-server layouts. Hardlink and symlink modes keep torrents
          seeding.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList>
            <TabsTrigger value="libraries">Libraries</TabsTrigger>
            <TabsTrigger value="rename">Quick Rename</TabsTrigger>
            <TabsTrigger value="dry-run">Dry Run</TabsTrigger>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="libraries" className="mt-4">
          <LibrariesTab />
        </TabsContent>
        <TabsContent value="rename" className="mt-4">
          <RenameTab />
        </TabsContent>
        <TabsContent value="dry-run" className="mt-4">
          <DryRunTab />
        </TabsContent>
        <TabsContent value="jobs" className="mt-4">
          <JobsTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------

function LibrariesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MediaLibrary | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: api.media.libraries,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media', 'libraries'] });

  const toggleEnabled = async (lib: MediaLibrary, isEnabled: boolean) => {
    try {
      await api.media.updateLibrary(lib.id, { isEnabled });
      invalidate();
    } catch (err) {
      toast.error('Could not update library', err instanceof ApiError ? err.message : undefined);
    }
  };

  const remove = async (lib: MediaLibrary) => {
    if (!confirm(`Delete library "${lib.name}"?`)) return;
    try {
      await api.media.deleteLibrary(lib.id);
      toast.success('Library deleted', lib.name);
      invalidate();
    } catch (err) {
      toast.error('Could not delete library', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Add library
        </Button>
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
              description="Define a library to map a media kind to a destination path and naming template."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Add your first library
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((lib) => (
            <Card key={lib.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{lib.name}</p>
                    <Badge variant="secondary">{kindLabel(lib.kind)}</Badge>
                    <Badge variant="info">{presetLabel(lib.preset)}</Badge>
                    <Badge variant="outline">{modeLabel(lib.mode)}</Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{lib.path}</p>
                  {lib.template && (
                    <p className="mt-1 truncate font-mono text-xs text-foreground/70">{lib.template}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={lib.isEnabled}
                    onCheckedChange={(v) => toggleEnabled(lib, v)}
                    aria-label="Toggle library"
                  />
                  <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(lib)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => remove(lib)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
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
  const [mode, setMode] = useState<RenameMode>(library?.mode ?? 'preview');
  const [template, setTemplate] = useState(library?.template ?? '');
  const [enabled, setEnabled] = useState(library?.isEnabled ?? true);
  const [saving, setSaving] = useState(false);

  const defaultTemplate = presetTemplate(presets, preset, kind);

  const submit = async () => {
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
          Maps a media kind to a destination path and naming template.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="lib-name">Name</Label>
          <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TV Shows" />
        </div>
        <div>
          <Label htmlFor="lib-path">Destination path</Label>
          <PathPicker id="lib-path" value={path} onChange={setPath} placeholder="/media/tv" aria-label="Destination path" pickerTitle="Choose a library folder" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="lib-kind">Kind</Label>
            <Select id="lib-kind" value={kind} onChange={(e) => setKind(e.target.value as MediaKind)} options={KIND_OPTIONS} />
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
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="lib-enabled">Enabled</Label>
          <Switch id="lib-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !path.trim()}>
          {library ? 'Save changes' : 'Add library'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rename (preview + apply)
// ---------------------------------------------------------------------------

function RenameTab() {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canApply = hasPermission(PERMISSIONS.FILES_MANAGE);

  const { data: libraries } = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.libraries });

  const [path, setPath] = useState('');
  const [preset, setPreset] = useState<Preset>('plex');
  const [mode, setMode] = useState<RenameMode>('preview');
  const [libraryPath, setLibraryPath] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<RenamePlan | null>(null);

  const libraryOptions = useMemo(
    () => [
      { value: '', label: 'Manual…' },
      ...(libraries ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.path})` })),
    ],
    [libraries],
  );

  const applyLibrary = (id: string) => {
    const lib = libraries?.find((l) => l.id === id);
    if (!lib) return;
    setPreset(lib.preset);
    setMode(lib.mode);
    setLibraryPath(lib.path);
  };

  const body = () => ({ path: path.trim(), preset, mode, libraryPath: libraryPath.trim() });

  const runPreview = async () => {
    if (!path.trim() || !libraryPath.trim()) {
      toast.error('Missing fields', 'A source path and a destination library path are required.');
      return;
    }
    setPreviewing(true);
    try {
      const result = await api.media.preview(body());
      setPlan(result);
    } catch (err) {
      toast.error('Preview failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!confirm('Apply this rename plan to disk?')) return;
    setApplying(true);
    try {
      const res = await api.media.apply(body());
      setPlan(res.plan);
      toast.success(
        'Rename applied',
        `${res.applied} applied, ${res.skipped} skipped, ${res.failed} failed.`,
      );
    } catch (err) {
      toast.error('Apply failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <Label htmlFor="rn-path">Source path</Label>
            <PathPicker
              id="rn-path"
              value={path}
              onChange={setPath}
              placeholder="/downloads/Show.Name.S01"
              aria-label="Source path"
              pickerTitle="Choose the source folder"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="rn-library">Use library</Label>
              <Select
                id="rn-library"
                onChange={(e) => applyLibrary(e.target.value)}
                options={libraryOptions}
              />
            </div>
            <div>
              <Label htmlFor="rn-dest">Destination library path</Label>
              <PathPicker
                id="rn-dest"
                value={libraryPath}
                onChange={setLibraryPath}
                placeholder="/media/tv"
                aria-label="Destination library path"
                pickerTitle="Choose a library folder"
              />
            </div>
            <div>
              <Label htmlFor="rn-preset">Preset</Label>
              <Select id="rn-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={PRESET_OPTIONS} />
            </div>
            <div>
              <Label htmlFor="rn-mode">Mode</Label>
              <Select id="rn-mode" value={mode} onChange={(e) => setMode(e.target.value as RenameMode)} options={MODE_OPTIONS} />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Preview is a safe dry-run. Hardlink and symlink modes keep the torrent seeding.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={runPreview} loading={previewing}>
                <Play className="h-4 w-4" /> Preview
              </Button>
              {canApply && (
                <Button onClick={runApply} loading={applying} disabled={!plan || plan.items.length === 0}>
                  <Save className="h-4 w-4" /> Apply
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {plan && <PlanView plan={plan} />}
    </div>
  );
}

function PlanView({ plan }: { plan: RenamePlan }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Rename plan</p>
          <Badge variant="secondary">{kindLabel(plan.kind)}</Badge>
          <Badge variant="info">{presetLabel(plan.preset)}</Badge>
          <Badge variant="outline">{modeLabel(plan.mode)}</Badge>
          <span className="text-xs text-muted-foreground">{plan.items.length} item{plan.items.length === 1 ? '' : 's'}</span>
        </div>

        {plan.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            {plan.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}

        {plan.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files to rename.</p>
        ) : (
          <div className="space-y-2">
            {plan.items.map((item, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-md border border-border/60 p-3',
                  item.skipped && 'opacity-60',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.skipped ? 'secondary' : 'success'}>{item.action}</Badge>
                  {item.isSubtitle && <Badge variant="outline">subtitle</Badge>}
                  {item.isSample && <Badge variant="warning">sample</Badge>}
                  {item.isExtra && <Badge variant="outline">extra</Badge>}
                  {item.reason && (
                    <span className="text-xs text-muted-foreground">{item.reason}</span>
                  )}
                </div>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{item.source}</p>
                {item.destination && (
                  <p className="mt-0.5 break-all font-mono text-xs text-foreground/80">
                    → {item.destination}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'history'],
    queryFn: api.media.history,
  });

  if (isLoading) return <CenteredSpinner label="Loading history…" />;
  if (isError) return <ErrorState message="Could not load history." onRetry={() => refetch()} />;
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="No operations yet"
            description="Applied rename operations are recorded here."
          />
        </CardContent>
      </Card>
    );
  }

  const tone = (status: string) =>
    status === 'success' || status === 'applied'
      ? 'success'
      : status === 'failed'
        ? 'destructive'
        : 'secondary';

  return (
    <div className="space-y-2">
      {data.map((op) => (
        <Card key={op.id}>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={tone(op.status)} dot>
                  {op.status}
                </Badge>
                <Badge variant="outline">{op.action}</Badge>
                <Badge variant="secondary">{modeLabel(op.mode)}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">{formatRelativeTime(op.createdAt)}</span>
            </div>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{op.source}</p>
            {op.destination && (
              <p className="mt-0.5 break-all font-mono text-xs text-foreground/80">→ {op.destination}</p>
            )}
            {op.message && <p className="mt-1 text-xs text-muted-foreground">{op.message}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;
}
function presetLabel(preset: string): string {
  return PRESET_OPTIONS.find((p) => p.value === preset)?.label ?? preset;
}
function modeLabel(mode: string): string {
  return MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode;
}
