import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { RenameTokensHelp } from './RenameTokensHelp';
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
  const { t } = useTranslation('media');
  const presetOptions = PRESET_OPTIONS.map((o) => ({
    value: o.value,
    label: t(`renamer.presetOption.${o.value}` as 'renamer.presetOption.plex'),
  }));
  const modeOptions = MODE_OPTIONS.map((o) => ({
    value: o.value,
    label: t(`renamer.modeOption.${o.value}` as 'renamer.modeOption.preview'),
  }));

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
      toast.error(t('renamer.dryRun.sourceRequiredTitle'), t('renamer.dryRun.sourceRequiredBody'));
      return false;
    }
    if (!form.paths.trim()) {
      toast.error(t('renamer.dryRun.noFilesTitle'), t('renamer.dryRun.noFilesBody'));
      return false;
    }
    if (!form.libraryPath.trim()) {
      toast.error(t('renamer.dryRun.libraryRequiredTitle'), t('renamer.dryRun.libraryRequiredBody'));
      return false;
    }
    return true;
  };

  const dryRunMutation = useMutation({
    mutationFn: () => api.mediaRenamer.dryRun(buildBody()),
    onSuccess: (res) => {
      setPlan(res.plan);
      toast.success(
        t('renamer.dryRun.completeTitle'),
        t('renamer.dryRun.completeBody', { count: res.plan.items.length }),
      );
    },
    onError: (err) =>
      toast.error(t('renamer.dryRun.failed'), err instanceof ApiError ? err.message : undefined),
  });

  const executeMutation = useMutation({
    mutationFn: () => api.mediaRenamer.execute(buildBody()),
    onSuccess: (job) => {
      toast.success(
        t('renamer.dryRun.execStartedTitle'),
        t('renamer.dryRun.execStartedBody', { id: job.id.slice(0, 8) }),
      );
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'jobs'] });
    },
    onError: (err) =>
      toast.error(t('renamer.dryRun.execFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const planItems = plan?.items ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="mr-source">{t('renamer.dryRun.source')}</Label>
              <Input
                id="mr-source"
                value={form.sourceName}
                onChange={(e) => setForm((f) => ({ ...f, sourceName: e.target.value }))}
                placeholder={t('renamer.dryRun.sourcePlaceholder')}
              />
            </div>
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="mr-paths">{t('renamer.dryRun.paths')}</Label>
              <Textarea
                id="mr-paths"
                value={form.paths}
                onChange={(e) => setForm((f) => ({ ...f, paths: e.target.value }))}
                placeholder={t('renamer.dryRun.pathsPlaceholder')}
                className="min-h-[120px] font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t('renamer.dryRun.pathsHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-preset">{t('renamer.dryRun.preset')}</Label>
              <Select
                id="mr-preset"
                value={form.preset}
                onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value as Preset }))}
                options={presetOptions}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-mode">{t('renamer.dryRun.mode')}</Label>
              <Select
                id="mr-mode"
                value={form.mode}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as RenameMode }))}
                options={modeOptions}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-library">{t('renamer.dryRun.library')}</Label>
              <PathPicker
                id="mr-library"
                value={form.libraryPath}
                onChange={(v) => setForm((f) => ({ ...f, libraryPath: v }))}
                placeholder={t('renamer.dryRun.libraryPlaceholder')}
                aria-label={t('renamer.dryRun.library')}
                pickerTitle={t('renamer.dryRun.libraryPicker')}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5"><Label htmlFor="mr-template">{t('renamer.dryRun.template')}</Label><RenameTokensHelp /></div>
              <Input
                id="mr-template"
                value={form.template}
                onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
                placeholder={t('renamer.dryRun.templatePlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => validate() && dryRunMutation.mutate()}
              loading={dryRunMutation.isPending}
            >
              <ScanSearch className="h-4 w-4" /> {t('renamer.dryRun.runBtn')}
            </Button>
            {canExecute && (
              <Button
                variant="outline"
                onClick={() => validate() && executeMutation.mutate()}
                loading={executeMutation.isPending}
              >
                <Play className="h-4 w-4" /> {t('renamer.dryRun.executeBtn')}
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
                  {t('renamer.dryRun.plan')} <span className="text-muted-foreground">· {plan.kind}</span>
                </p>
                <Badge variant="secondary">{t('common.items', { count: planItems.length })}</Badge>
              </div>
              {planItems.length === 0 ? (
                <EmptyState
                  icon={<ListChecks className="h-6 w-6" />}
                  title={t('renamer.dryRun.nothingTitle')}
                  description={t('renamer.dryRun.nothingBody')}
                />
              ) : (
                <div className="overflow-x-auto scrollbar-thin">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('renamer.dryRun.col.source')}</TableHead>
                        <TableHead>{t('renamer.dryRun.col.destination')}</TableHead>
                        <TableHead>{t('renamer.dryRun.col.action')}</TableHead>
                        <TableHead>{t('renamer.dryRun.col.kind')}</TableHead>
                        <TableHead className="pr-4">{t('renamer.dryRun.col.notes')}</TableHead>
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
                              {item.skipped ? t('renamer.dryRun.skip') : item.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="capitalize">{item.kind}</span>
                              {item.isSubtitle && <Badge variant="outline">{t('renamer.dryRun.badge.sub')}</Badge>}
                              {item.isSample && <Badge variant="outline">{t('renamer.dryRun.badge.sample')}</Badge>}
                              {item.isExtra && <Badge variant="outline">{t('renamer.dryRun.badge.extra')}</Badge>}
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
  const { t } = useTranslation('media');
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Info className="h-4 w-4 text-info" /> {t('renamer.templateHints.title')}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {TEMPLATE_HINTS.map((hint) => (
            <div
              key={hint.kind}
              className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2.5"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t(`renamer.templateHints.${hint.kind}` as 'renamer.templateHints.tv')}
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
  const { t } = useTranslation('media');

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
            <CenteredSpinner label={t('renamer.jobs.loading')} />
          ) : jobsQuery.isError ? (
            <ErrorState message={t('renamer.jobs.error')} onRetry={() => jobsQuery.refetch()} />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<Clapperboard className="h-6 w-6" />}
              title={t('renamer.jobs.emptyTitle')}
              description={t('renamer.jobs.emptyBody')}
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('renamer.jobs.col.source')}</TableHead>
                    <TableHead>{t('renamer.jobs.col.type')}</TableHead>
                    <TableHead>{t('renamer.jobs.col.mode')}</TableHead>
                    <TableHead>{t('renamer.jobs.col.status')}</TableHead>
                    <TableHead>{t('renamer.jobs.col.confidence')}</TableHead>
                    <TableHead>{t('renamer.jobs.col.created')}</TableHead>
                    <TableHead className="pr-4 text-right">{t('renamer.jobs.col.actions')}</TableHead>
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
                            aria-label={t('renamer.jobs.viewAria')}
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
  const { t } = useTranslation('media');

  const jobQuery = useQuery({
    queryKey: ['media-renamer', 'job', jobId],
    queryFn: () => api.mediaRenamer.job(jobId),
  });

  const rollbackMutation = useMutation({
    mutationFn: () => api.mediaRenamer.rollback(jobId),
    onSuccess: (res) => {
      toast.success(
        t('renamer.jobDetail.rolledBackTitle'),
        t('renamer.jobDetail.rolledBackBody', { count: res.reverted }),
      );
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'jobs'] });
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'job', jobId] });
    },
    onError: (err) =>
      toast.error(t('renamer.jobDetail.rollbackFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const job: MediaRenameJobDetail | undefined = jobQuery.data;

  return (
    <Dialog open onClose={onClose} title={t('renamer.jobDetail.title')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('renamer.jobDetail.heading')}</DialogTitle>
        <DialogDescription>{t('renamer.jobDetail.description')}</DialogDescription>
      </DialogHeader>

      {jobQuery.isLoading ? (
        <CenteredSpinner label={t('renamer.jobDetail.loading')} />
      ) : jobQuery.isError ? (
        <ErrorState message={t('renamer.jobDetail.error')} onRetry={() => jobQuery.refetch()} />
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
                  <TableHead className="pl-3">{t('renamer.jobDetail.col.original')}</TableHead>
                  <TableHead>{t('renamer.jobDetail.col.result')}</TableHead>
                  <TableHead>{t('renamer.jobDetail.col.action')}</TableHead>
                  <TableHead className="pr-3">{t('renamer.jobDetail.col.status')}</TableHead>
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
                      {t('renamer.jobDetail.noFiles')}
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
              if (window.confirm(t('renamer.jobDetail.rollbackConfirm')))
                rollbackMutation.mutate();
            }}
            loading={rollbackMutation.isPending}
          >
            <RotateCcw className="h-4 w-4" /> {t('renamer.jobDetail.rollbackBtn')}
          </Button>
        )}
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export function TemplatesTab() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_RENAMER_MANAGE_TEMPLATES);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<MediaRenamerTemplate | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['media-renamer', 'templates'],
    queryFn: api.mediaRenamer.templates,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.mediaRenamer.deleteTemplate(id),
    onSuccess: () => {
      toast.success(t('renamer.templates.deletedTitle'));
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'templates'] });
    },
    onError: (err) =>
      toast.error(t('renamer.templates.deleteError'), err instanceof ApiError ? err.message : undefined),
  });

  const templates = templatesQuery.data ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> {t('renamer.templates.addBtn')}
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {templatesQuery.isLoading ? (
            <CenteredSpinner label={t('renamer.templates.loading')} />
          ) : templatesQuery.isError ? (
            <ErrorState
              message={t('renamer.templates.error')}
              onRetry={() => templatesQuery.refetch()}
            />
          ) : templates.length === 0 ? (
            <EmptyState
              icon={<FilePenLine className="h-6 w-6" />}
              title={t('renamer.templates.emptyTitle')}
              description={t('renamer.templates.emptyBody')}
              action={
                canManage ? (
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> {t('renamer.templates.addBtn')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('renamer.templates.col.name')}</TableHead>
                    <TableHead>{t('renamer.templates.col.type')}</TableHead>
                    <TableHead>{t('renamer.templates.col.preset')}</TableHead>
                    <TableHead>{t('renamer.templates.col.template')}</TableHead>
                    <TableHead>{t('renamer.templates.col.enabled')}</TableHead>
                    <TableHead className="pr-4 text-right">{t('renamer.templates.col.actions')}</TableHead>
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
                          {tpl.enabled ? t('common.enabled') : t('common.disabled')}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {canManage && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setEditing(tpl)}>
                                {t('renamer.templates.edit')}
                              </Button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm(t('renamer.templates.deleteConfirm', { name: tpl.name })))
                                    deleteMutation.mutate(tpl.id);
                                }}
                                aria-label={t('renamer.templates.deleteAria', { name: tpl.name })}
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
  const { t } = useTranslation('media');
  const isEdit = Boolean(template);
  const presetOptions = PRESET_OPTIONS.map((o) => ({
    value: o.value,
    label: t(`renamer.presetOption.${o.value}` as 'renamer.presetOption.plex'),
  }));
  const mediaTypeOptions = MEDIA_TYPE_OPTIONS.map((o) => ({
    value: o.value,
    label: t(`renamer.mediaTypeOption.${o.value}` as 'renamer.mediaTypeOption.tv'),
  }));
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
      toast.success(isEdit ? t('renamer.templateDialog.updatedTitle') : t('renamer.templateDialog.createdTitle'));
      queryClient.invalidateQueries({ queryKey: ['media-renamer', 'templates'] });
      onClose();
    },
    onError: (err) =>
      toast.error(t('renamer.templateDialog.saveError'), err instanceof ApiError ? err.message : undefined),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.template.trim()) {
      toast.error(t('renamer.templateDialog.missingTitle'), t('renamer.templateDialog.missingBody'));
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={isEdit ? t('renamer.templateDialog.editTitle') : t('renamer.templateDialog.addTitle')}>
      <DialogHeader>
        <DialogTitle>{isEdit ? t('renamer.templateDialog.editTitle') : t('renamer.templateDialog.addTitle')}</DialogTitle>
        <DialogDescription>{t('renamer.templateDialog.description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">{t('renamer.templateDialog.name')}</Label>
            <Input
              id="tpl-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-type">{t('renamer.templateDialog.mediaType')}</Label>
            <Select
              id="tpl-type"
              value={form.mediaType}
              onChange={(e) => setForm((f) => ({ ...f, mediaType: e.target.value }))}
              options={mediaTypeOptions}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-preset">{t('renamer.templateDialog.preset')}</Label>
            <Select
              id="tpl-preset"
              value={form.serverPreset}
              onChange={(e) => setForm((f) => ({ ...f, serverPreset: e.target.value }))}
              options={presetOptions}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5"><Label htmlFor="tpl-template">{t('renamer.templateDialog.template')}</Label><RenameTokensHelp /></div>
          <Textarea
            id="tpl-template"
            value={form.template}
            onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
            placeholder={t('renamer.templateDialog.templatePlaceholder')}
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
          {t('renamer.templateDialog.enabled')}
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            <Save className="h-4 w-4" /> {isEdit ? t('renamer.templateDialog.save') : t('renamer.templateDialog.create')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
