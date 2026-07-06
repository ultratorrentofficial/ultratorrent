import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Pagination } from '@/components/ui/pagination';
import { cn } from '@/lib/utils';
import {
  kindLabel,
  libraryKindOptions,
  modeLabel,
  modeOptions,
  presetLabel,
  presetOptions,
} from './media-manager/constants';
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
  const { t } = useTranslation('media');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('renamer.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('renamer.subtitle')}
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList>
            <TabsTrigger value="libraries">{t('renamer.tab.libraries')}</TabsTrigger>
            <TabsTrigger value="rename">{t('renamer.tab.rename')}</TabsTrigger>
            <TabsTrigger value="dry-run">{t('renamer.tab.dryRun')}</TabsTrigger>
            <TabsTrigger value="jobs">{t('renamer.tab.jobs')}</TabsTrigger>
            <TabsTrigger value="templates">{t('renamer.tab.templates')}</TabsTrigger>
            <TabsTrigger value="history">{t('renamer.tab.history')}</TabsTrigger>
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
  const { t } = useTranslation('media');
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
      toast.error(t('renamer.libraries.updateError'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const remove = async (lib: MediaLibrary) => {
    if (!confirm(t('renamer.libraries.deleteConfirm', { name: lib.name }))) return;
    try {
      await api.media.deleteLibrary(lib.id);
      toast.success(t('renamer.libraries.deletedTitle'), lib.name);
      invalidate();
    } catch (err) {
      toast.error(t('renamer.libraries.deleteError'), err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> {t('renamer.libraries.addBtn')}
        </Button>
      </div>

      {isLoading ? (
        <CenteredSpinner label={t('renamer.libraries.loading')} />
      ) : isError ? (
        <ErrorState message={t('renamer.libraries.error')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FolderTree className="h-6 w-6" />}
              title={t('renamer.libraries.emptyTitle')}
              description={t('renamer.libraries.emptyBody')}
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> {t('renamer.libraries.addFirst')}
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
                    <Badge variant="secondary">{kindLabel(t, lib.kind)}</Badge>
                    <Badge variant="info">{presetLabel(t, lib.preset)}</Badge>
                    <Badge variant="outline">{modeLabel(t, lib.mode)}</Badge>
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
                    aria-label={t('renamer.libraries.toggleAria')}
                  />
                  <Button variant="ghost" size="icon" aria-label={t('renamer.libraries.editAria')} onClick={() => setEditing(lib)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('renamer.libraries.deleteAria')} onClick={() => remove(lib)}>
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
  const { t } = useTranslation('media');
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
      toast.success(library ? t('renamer.libraries.updatedTitle') : t('renamer.libraries.createdTitle'), body.name);
      onSaved();
    } catch (err) {
      toast.error(t('renamer.libraries.saveError'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{library ? t('renamer.dialog.editTitle') : t('renamer.dialog.addTitle')}</DialogTitle>
        <DialogDescription>
          {t('renamer.dialog.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="lib-name">{t('renamer.field.name')}</Label>
          <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('renamer.field.namePlaceholder')} />
        </div>
        <div>
          <Label htmlFor="lib-path">{t('renamer.field.path')}</Label>
          <PathPicker id="lib-path" value={path} onChange={setPath} placeholder={t('renamer.field.pathPlaceholder')} aria-label={t('renamer.field.pathAria')} pickerTitle={t('renamer.field.pathPicker')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="lib-kind">{t('renamer.field.kind')}</Label>
            <Select id="lib-kind" value={kind} onChange={(e) => setKind(e.target.value as MediaKind)} options={libraryKindOptions(t)} />
          </div>
          <div>
            <Label htmlFor="lib-preset">{t('renamer.field.preset')}</Label>
            <Select id="lib-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={presetOptions(t)} />
          </div>
          <div>
            <Label htmlFor="lib-mode">{t('renamer.field.mode')}</Label>
            <Select id="lib-mode" value={mode} onChange={(e) => setMode(e.target.value as RenameMode)} options={modeOptions(t)} />
          </div>
        </div>
        <div>
          <Label htmlFor="lib-template">{t('renamer.field.template')}</Label>
          <Textarea
            id="lib-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={defaultTemplate || t('renamer.field.templatePlaceholder')}
            className="font-mono text-xs"
          />
          {defaultTemplate && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('renamer.presetDefault')} <code className="font-mono">{defaultTemplate}</code>
            </p>
          )}
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="lib-enabled">{t('renamer.field.enabled')}</Label>
          <Switch id="lib-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !path.trim()}>
          {library ? t('common.saveChanges') : t('renamer.dialog.addTitle')}
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
  const { t } = useTranslation('media');
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
      { value: '', label: t('renamer.rename.manual') },
      ...(libraries ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.path})` })),
    ],
    [libraries, t],
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
      toast.error(t('renamer.rename.missingFieldsTitle'), t('renamer.rename.missingFieldsBody'));
      return;
    }
    setPreviewing(true);
    try {
      const result = await api.media.preview(body());
      setPlan(result);
    } catch (err) {
      toast.error(t('renamer.rename.previewFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!confirm(t('renamer.rename.confirmApply'))) return;
    setApplying(true);
    try {
      const res = await api.media.apply(body());
      setPlan(res.plan);
      toast.success(
        t('renamer.rename.appliedTitle'),
        t('renamer.rename.appliedBody', { applied: res.applied, skipped: res.skipped, failed: res.failed }),
      );
    } catch (err) {
      toast.error(t('renamer.rename.applyFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <Label htmlFor="rn-path">{t('renamer.rename.source')}</Label>
            <PathPicker
              id="rn-path"
              value={path}
              onChange={setPath}
              placeholder={t('renamer.rename.sourcePlaceholder')}
              aria-label={t('renamer.rename.sourceAria')}
              pickerTitle={t('renamer.rename.sourcePicker')}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="rn-library">{t('renamer.rename.useLibrary')}</Label>
              <Select
                id="rn-library"
                onChange={(e) => applyLibrary(e.target.value)}
                options={libraryOptions}
              />
            </div>
            <div>
              <Label htmlFor="rn-dest">{t('renamer.rename.dest')}</Label>
              <PathPicker
                id="rn-dest"
                value={libraryPath}
                onChange={setLibraryPath}
                placeholder={t('renamer.rename.destPlaceholder')}
                aria-label={t('renamer.rename.destAria')}
                pickerTitle={t('renamer.rename.destPicker')}
              />
            </div>
            <div>
              <Label htmlFor="rn-preset">{t('renamer.rename.preset')}</Label>
              <Select id="rn-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={presetOptions(t)} />
            </div>
            <div>
              <Label htmlFor="rn-mode">{t('renamer.rename.mode')}</Label>
              <Select id="rn-mode" value={mode} onChange={(e) => setMode(e.target.value as RenameMode)} options={modeOptions(t)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t('renamer.rename.hint')}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={runPreview} loading={previewing}>
                <Play className="h-4 w-4" /> {t('renamer.rename.previewBtn')}
              </Button>
              {canApply && (
                <Button onClick={runApply} loading={applying} disabled={!plan || plan.items.length === 0}>
                  <Save className="h-4 w-4" /> {t('renamer.rename.applyBtn')}
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
  const { t } = useTranslation('media');
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{t('renamer.plan.title')}</p>
          <Badge variant="secondary">{kindLabel(t, plan.kind)}</Badge>
          <Badge variant="info">{presetLabel(t, plan.preset)}</Badge>
          <Badge variant="outline">{modeLabel(t, plan.mode)}</Badge>
          <span className="text-xs text-muted-foreground">{t('common.items', { count: plan.items.length })}</span>
        </div>

        {plan.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            {plan.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}

        {plan.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noFilesToRename')}</p>
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
                  {item.isSubtitle && <Badge variant="outline">{t('renamer.plan.badge.subtitle')}</Badge>}
                  {item.isSample && <Badge variant="warning">{t('renamer.plan.badge.sample')}</Badge>}
                  {item.isExtra && <Badge variant="outline">{t('renamer.plan.badge.extra')}</Badge>}
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
  const { t } = useTranslation('media');
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'history', page],
    queryFn: () => api.media.history({ page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  const ops = data?.items ?? [];

  if (isLoading) return <CenteredSpinner label={t('renamer.history.loading')} />;
  if (isError) return <ErrorState message={t('renamer.history.error')} onRetry={() => refetch()} />;
  if (ops.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title={t('renamer.history.emptyTitle')}
            description={t('renamer.history.emptyBody')}
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
      {ops.map((op) => (
        <Card key={op.id}>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={tone(op.status)} dot>
                  {op.status}
                </Badge>
                <Badge variant="outline">{op.action}</Badge>
                <Badge variant="secondary">{modeLabel(t, op.mode)}</Badge>
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
      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} busy={isFetching} />
    </div>
  );
}

