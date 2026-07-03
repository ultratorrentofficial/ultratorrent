import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clapperboard,
  Eye,
  FilePenLine,
  Info,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  Save,
  ScanSearch,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ApiError,
  api,
  type MediaRenamerPlan,
  type MediaRenamerRunBody,
  type MediaRenamerTemplate,
  type MediaRenameJobDetail,
  type Preset,
  type RenameMode,
  type UpsertMediaRenamerTemplateInput,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

const PRESET_OPTIONS: { value: Preset; label: string }[] = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kodi', label: 'Kodi' },
  { value: 'custom', label: 'Custom (template)' },
];

const MODE_OPTIONS: { value: RenameMode; label: string }[] = [
  { value: 'preview', label: 'Preview only' },
  { value: 'rename_in_place', label: 'Rename in place' },
  { value: 'rename_move', label: 'Rename + move' },
  { value: 'copy', label: 'Copy' },
  { value: 'hardlink', label: 'Hardlink' },
  { value: 'symlink', label: 'Symlink' },
];

const MEDIA_TYPE_OPTIONS = [
  { value: 'tv', label: 'TV' },
  { value: 'anime', label: 'Anime' },
  { value: 'movie', label: 'Movie' },
  { value: 'music', label: 'Music' },
  { value: 'audiobook', label: 'Audiobook' },
  { value: 'general', label: 'General' },
];

/** Informational default-template hints surfaced on the Dry Run + Templates tabs. */
const TEMPLATE_HINTS: { kind: string; label: string; template: string }[] = [
  {
    kind: 'tv',
    label: 'TV',
    template: '{title} ({year})/Season {season}/{title} - S{season}E{episode} - {episodeTitle}',
  },
  {
    kind: 'movie',
    label: 'Movie',
    template: '{title} ({year})/{title} ({year}) {resolution}',
  },
  {
    kind: 'anime',
    label: 'Anime',
    template: '{title}/{title} - {absoluteEpisode} [{releaseGroup}]',
  },
];

function actionVariant(action: string): BadgeVariant {
  switch (action.toLowerCase()) {
    case 'rename':
    case 'rename_in_place':
      return 'info';
    case 'move':
    case 'rename_move':
      return 'default';
    case 'copy':
      return 'success';
    case 'hardlink':
    case 'symlink':
      return 'secondary';
    case 'skip':
    case 'skipped':
      return 'warning';
    case 'error':
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

function jobStatusVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'done':
      return 'success';
    case 'running':
    case 'in_progress':
    case 'pending':
      return 'info';
    case 'preview':
    case 'planned':
      return 'secondary';
    case 'failed':
    case 'error':
      return 'destructive';
    case 'rolled_back':
    case 'reverted':
      return 'warning';
    default:
      return 'outline';
  }
}

/**
 * Tab sections for the unified Intelligent Media Renamer page. These were the
 * "Media Renamer" page; they now render as tabs inside `MediaPage` alongside the
 * Libraries/History tabs. Each is self-contained.
 */
export function DryRunTab() {
  const { hasPermission } = useAuth();
  const canExecute = hasPermission(PERMISSIONS.MEDIA_RENAMER_EXECUTE);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    sourceName: '',
    paths: '',
    preset: 'plex' as Preset,
    mode: 'preview' as RenameMode,
    libraryPath: '',
    template: '',
  });
  const [plan, setPlan] = useState<MediaRenamerPlan | null>(null);

  const buildBody = (): MediaRenamerRunBody => {
    const files = form.paths
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => ({ path }));
    return {
      sourceName: form.sourceName.trim(),
      files,
      preset: form.preset,
      mode: form.mode,
      libraryPath: form.libraryPath.trim(),
      template: form.template.trim() || undefined,
    };
  };

  const validate = (): boolean => {
    if (!form.sourceName.trim()) {
      toast.error('Source name required', 'Enter the release / source name to parse.');
      return false;
    }
    if (!form.paths.trim()) {
      toast.error('No files', 'Add at least one file path (one per line).');
      return false;
    }
    if (!form.libraryPath.trim()) {
      toast.error('Library path required', 'Set the destination library path.');
      return false;
    }
    return true;
  };

  const dryRunMutation = useMutation({
    mutationFn: () => api.mediaRenamer.dryRun(buildBody()),
    onSuccess: (res) => {
      setPlan(res.plan);
      toast.success('Dry run complete', `${res.plan.items.length} item(s) planned.`);
    },
    onError: (err) =>
      toast.error('Dry run failed', err instanceof ApiError ? err.message : undefined),
  });

  const executeMutation = useMutation({
    mutationFn: () => api.mediaRenamer.execute(buildBody()),
    onSuccess: (job) => {
      toast.success('Execution started', `Job ${job.id.slice(0, 8)} created.`);
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'jobs'] });
    },
    onError: (err) =>
      toast.error('Execution failed', err instanceof ApiError ? err.message : undefined),
  });

  const planItems = plan?.items ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="mr-source">Source name</Label>
              <Input
                id="mr-source"
                value={form.sourceName}
                onChange={(e) => setForm((f) => ({ ...f, sourceName: e.target.value }))}
                placeholder="e.g. Some.Show.S01E02.1080p.WEB-DL.x264-GROUP"
              />
            </div>
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="mr-paths">File paths</Label>
              <Textarea
                id="mr-paths"
                value={form.paths}
                onChange={(e) => setForm((f) => ({ ...f, paths: e.target.value }))}
                placeholder={'One path per line, e.g.\n/downloads/show.s01e02.mkv\n/downloads/show.s01e02.eng.srt'}
                className="min-h-[120px] font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                One file per line. Subtitles, samples and extras are detected automatically.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-preset">Server preset</Label>
              <Select
                id="mr-preset"
                value={form.preset}
                onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value as Preset }))}
                options={PRESET_OPTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-mode">Mode</Label>
              <Select
                id="mr-mode"
                value={form.mode}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as RenameMode }))}
                options={MODE_OPTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-library">Library path</Label>
              <PathPicker
                id="mr-library"
                value={form.libraryPath}
                onChange={(v) => setForm((f) => ({ ...f, libraryPath: v }))}
                placeholder="/media/tv"
                aria-label="Library path"
                pickerTitle="Choose a library folder"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-template">Template (optional)</Label>
              <Input
                id="mr-template"
                value={form.template}
                onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
                placeholder="Override the preset template"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => validate() && dryRunMutation.mutate()}
              loading={dryRunMutation.isPending}
            >
              <ScanSearch className="h-4 w-4" /> Dry run
            </Button>
            {canExecute && (
              <Button
                variant="outline"
                onClick={() => validate() && executeMutation.mutate()}
                loading={executeMutation.isPending}
              >
                <Play className="h-4 w-4" /> Execute
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <TemplateHints />

      {plan && (
        <>
          {plan.warnings.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              {plan.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <p className="text-sm font-semibold">
                  Plan <span className="text-muted-foreground">· {plan.kind}</span>
                </p>
                <Badge variant="secondary">{planItems.length} items</Badge>
              </div>
              {planItems.length === 0 ? (
                <EmptyState
                  icon={<ListChecks className="h-6 w-6" />}
                  title="Nothing to do"
                  description="No file operations were planned for this source."
                />
              ) : (
                <div className="overflow-x-auto scrollbar-thin">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Source</TableHead>
                        <TableHead>Destination</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead className="pr-4">Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {planItems.map((item, i) => (
                        <TableRow key={`${item.source}-${i}`}>
                          <TableCell
                            className="max-w-[260px] truncate pl-4 font-mono text-xs"
                            title={item.source}
                          >
                            {item.source}
                          </TableCell>
                          <TableCell
                            className="max-w-[260px] truncate font-mono text-xs text-muted-foreground"
                            title={item.destination ?? ''}
                          >
                            {item.destination ?? '—'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={item.skipped ? 'warning' : actionVariant(item.action)} className="capitalize">
                              {item.skipped ? 'skip' : item.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="capitalize">{item.kind}</span>
                              {item.isSubtitle && <Badge variant="outline">sub</Badge>}
                              {item.isSample && <Badge variant="outline">sample</Badge>}
                              {item.isExtra && <Badge variant="outline">extra</Badge>}
                            </div>
                          </TableCell>
                          <TableCell
                            className="max-w-[220px] truncate pr-4 text-xs text-muted-foreground"
                            title={item.reason}
                          >
                            {item.reason || '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function TemplateHints() {
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Info className="h-4 w-4 text-info" /> Default template hints
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {TEMPLATE_HINTS.map((hint) => (
            <div
              key={hint.kind}
              className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2.5"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {hint.label}
              </p>
              <p className="mt-1 break-words font-mono text-[11px] text-foreground/90">
                {hint.template}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function JobsTab() {
  const [detailId, setDetailId] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: ['media-renamer', 'jobs'],
    queryFn: api.mediaRenamer.jobs,
    refetchInterval: 10_000,
  });

  const jobs = jobsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          {jobsQuery.isLoading ? (
            <CenteredSpinner label="Loading jobs…" />
          ) : jobsQuery.isError ? (
            <ErrorState message="Could not load jobs." onRetry={() => jobsQuery.refetch()} />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<Clapperboard className="h-6 w-6" />}
              title="No rename jobs yet"
              description="Run a dry run and execute it to create your first job."
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Source</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="pr-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell
                        className="max-w-[260px] truncate pl-4 font-mono text-xs"
                        title={job.sourcePath}
                      >
                        {job.sourcePath}
                      </TableCell>
                      <TableCell className="text-sm capitalize text-muted-foreground">
                        {job.mediaType}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{job.mode}</TableCell>
                      <TableCell>
                        <Badge variant={jobStatusVariant(job.status)} dot className="capitalize">
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {Math.round((job.confidenceScore ?? 0) * 100)}%
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatDateTime(job.createdAt)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end">
                          <button
                            type="button"
                            onClick={() => setDetailId(job.id)}
                            aria-label="View job"
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {detailId && <JobDetailDialog jobId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function JobDetailDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canRollback = hasPermission(PERMISSIONS.MEDIA_RENAMER_ROLLBACK);
  const toast = useToast();
  const queryClient = useQueryClient();

  const jobQuery = useQuery({
    queryKey: ['media-renamer', 'job', jobId],
    queryFn: () => api.mediaRenamer.job(jobId),
  });

  const rollbackMutation = useMutation({
    mutationFn: () => api.mediaRenamer.rollback(jobId),
    onSuccess: (res) => {
      toast.success('Rolled back', `${res.reverted} file(s) reverted.`);
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'jobs'] });
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'job', jobId] });
    },
    onError: (err) =>
      toast.error('Rollback failed', err instanceof ApiError ? err.message : undefined),
  });

  const job: MediaRenameJobDetail | undefined = jobQuery.data;

  return (
    <Dialog open onClose={onClose} title="Job detail" className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Rename job</DialogTitle>
        <DialogDescription>File-by-file outcome of this rename job.</DialogDescription>
      </DialogHeader>

      {jobQuery.isLoading ? (
        <CenteredSpinner label="Loading job…" />
      ) : jobQuery.isError ? (
        <ErrorState message="Could not load this job." onRetry={() => jobQuery.refetch()} />
      ) : job ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={jobStatusVariant(job.status)} dot className="capitalize">
              {job.status}
            </Badge>
            <span className="text-xs capitalize text-muted-foreground">{job.mediaType}</span>
            <span className="text-xs text-muted-foreground">{job.mode}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(job.createdAt)}</span>
          </div>

          <div className="overflow-x-auto scrollbar-thin rounded-md border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Original</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="pr-3">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(job.files ?? []).map((file, i) => (
                  <TableRow key={`${file.originalPath}-${i}`}>
                    <TableCell
                      className="max-w-[200px] truncate pl-3 font-mono text-[11px]"
                      title={file.originalPath}
                    >
                      {file.originalPath}
                    </TableCell>
                    <TableCell
                      className="max-w-[200px] truncate font-mono text-[11px] text-muted-foreground"
                      title={file.finalPath ?? file.proposedPath ?? ''}
                    >
                      {file.finalPath ?? file.proposedPath ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={actionVariant(file.action)} className="capitalize">
                        {file.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-3">
                      <Badge variant={jobStatusVariant(file.status)} className="capitalize">
                        {file.status}
                      </Badge>
                      {file.errorMessage && (
                        <p className="mt-1 text-[11px] text-destructive">{file.errorMessage}</p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(job.files ?? []).length === 0 && (
                  <TableRow>
                    <TableCell className="px-3 py-6 text-center text-sm text-muted-foreground" colSpan={4}>
                      No files recorded for this job.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      <DialogFooter>
        {canRollback && job && (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm('Roll back all file operations for this job?'))
                rollbackMutation.mutate();
            }}
            loading={rollbackMutation.isPending}
          >
            <RotateCcw className="h-4 w-4" /> Rollback
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}

export function TemplatesTab() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_RENAMER_MANAGE_TEMPLATES);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<MediaRenamerTemplate | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['media-renamer', 'templates'],
    queryFn: api.mediaRenamer.templates,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.mediaRenamer.deleteTemplate(id),
    onSuccess: () => {
      toast.success('Template deleted');
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'templates'] });
    },
    onError: (err) =>
      toast.error('Could not delete template', err instanceof ApiError ? err.message : undefined),
  });

  const templates = templatesQuery.data ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> Add template
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {templatesQuery.isLoading ? (
            <CenteredSpinner label="Loading templates…" />
          ) : templatesQuery.isError ? (
            <ErrorState
              message="Could not load templates."
              onRetry={() => templatesQuery.refetch()}
            />
          ) : templates.length === 0 ? (
            <EmptyState
              icon={<FilePenLine className="h-6 w-6" />}
              title="No custom templates"
              description="Add a naming template to override the built-in presets."
              action={
                canManage ? (
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> Add template
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Preset</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="pr-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((tpl) => (
                    <TableRow key={tpl.id}>
                      <TableCell className="pl-4 text-sm font-medium">{tpl.name}</TableCell>
                      <TableCell className="text-sm capitalize text-muted-foreground">
                        {tpl.mediaType}
                      </TableCell>
                      <TableCell className="text-sm capitalize text-muted-foreground">
                        {tpl.serverPreset}
                      </TableCell>
                      <TableCell
                        className="max-w-[280px] truncate font-mono text-xs text-muted-foreground"
                        title={tpl.template}
                      >
                        {tpl.template}
                      </TableCell>
                      <TableCell>
                        <Badge variant={tpl.enabled ? 'success' : 'secondary'}>
                          {tpl.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {canManage && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setEditing(tpl)}>
                                Edit
                              </Button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm(`Delete template "${tpl.name}"?`))
                                    deleteMutation.mutate(tpl.id);
                                }}
                                aria-label={`Delete ${tpl.name}`}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {showAdd && <TemplateDialog onClose={() => setShowAdd(false)} />}
      {editing && <TemplateDialog template={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateDialog({
  template,
  onClose,
}: {
  template?: MediaRenamerTemplate;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const isEdit = Boolean(template);
  const [form, setForm] = useState({
    name: template?.name ?? '',
    mediaType: template?.mediaType ?? 'tv',
    serverPreset: template?.serverPreset ?? 'plex',
    template: template?.template ?? '',
    enabled: template?.enabled ?? true,
  });

  const mutation = useMutation({
    mutationFn: () => {
      const body: UpsertMediaRenamerTemplateInput = {
        name: form.name.trim(),
        mediaType: form.mediaType,
        serverPreset: form.serverPreset,
        template: form.template.trim(),
        enabled: form.enabled,
      };
      return template
        ? api.mediaRenamer.updateTemplate(template.id, body)
        : api.mediaRenamer.createTemplate(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Template updated' : 'Template created');
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'templates'] });
      onClose();
    },
    onError: (err) =>
      toast.error('Could not save template', err instanceof ApiError ? err.message : undefined),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.template.trim()) {
      toast.error('Missing fields', 'Name and template are required.');
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Edit template' : 'Add template'}>
      <DialogHeader>
        <DialogTitle>{isEdit ? 'Edit template' : 'Add template'}</DialogTitle>
        <DialogDescription>
          Tokens like {'{title}'}, {'{year}'}, {'{season}'}, {'{episode}'} are expanded at rename time.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-type">Media type</Label>
            <Select
              id="tpl-type"
              value={form.mediaType}
              onChange={(e) => setForm((f) => ({ ...f, mediaType: e.target.value }))}
              options={MEDIA_TYPE_OPTIONS}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-preset">Server preset</Label>
            <Select
              id="tpl-preset"
              value={form.serverPreset}
              onChange={(e) => setForm((f) => ({ ...f, serverPreset: e.target.value }))}
              options={PRESET_OPTIONS}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-template">Template</Label>
          <Textarea
            id="tpl-template"
            value={form.template}
            onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
            placeholder="{title} ({year})/Season {season}/{title} - S{season}E{episode}"
            className="font-mono text-xs"
          />
        </div>
        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="h-4 w-4 rounded border-input bg-white/[0.02]"
          />
          Enabled
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            <Save className="h-4 w-4" /> {isEdit ? 'Save' : 'Create template'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
