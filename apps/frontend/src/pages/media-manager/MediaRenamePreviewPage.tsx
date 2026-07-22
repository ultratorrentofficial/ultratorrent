import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Play, Save } from 'lucide-react';
import {
  ApiError,
  api,
  type MediaLibrary,
  type RenamePlan,
  type RenameRequest,
} from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PathPicker } from '@/components/PathPicker';
import { CenteredSpinner } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { presetLabel, modeLabel } from './constants';

/** Destinations that appear more than once in a plan are conflicts. */
function conflictSet(plan: RenamePlan | undefined): Set<string> {
  const seen = new Map<string, number>();
  for (const item of plan?.items ?? []) {
    if (!item.destination || item.skipped) continue;
    seen.set(item.destination, (seen.get(item.destination) ?? 0) + 1);
  }
  const conflicts = new Set<string>();
  for (const [dest, count] of seen) if (count > 1) conflicts.add(dest);
  return conflicts;
}

export function MediaRenamePreviewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canApply = hasPermission(PERMISSIONS.MEDIA_MANAGER_RENAME);

  const librariesQuery = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.libraries });

  const [libraryId, setLibraryId] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [plan, setPlan] = useState<RenamePlan | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const libraries = librariesQuery.data ?? [];
  const library: MediaLibrary | undefined = libraries.find((l) => l.id === libraryId);

  const libraryOptions = useMemo(
    () => [
      { value: '', label: t('renamePreview.field.selectLibrary') },
      ...libraries.map((l) => ({ value: l.id, label: `${l.name} (${l.path})` })),
    ],
    [libraries, t],
  );

  const buildBody = (): RenameRequest | null => {
    if (!library || !sourcePath.trim()) return null;
    return {
      path: sourcePath.trim(),
      preset: library.preset,
      mode: library.mode,
      libraryPath: library.path,
      template: library.template ?? undefined,
    };
  };

  const preview = useMutation({
    mutationFn: () => {
      const body = buildBody();
      if (!body) throw new ApiError(400, t('renamePreview.pickFirst'));
      return api.media.preview(body);
    },
    onSuccess: (result) => setPlan(result),
    onError: (err) => toast.error(t('renamePreview.previewFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const apply = useMutation({
    mutationFn: () => {
      const body = buildBody();
      if (!body) throw new ApiError(400, t('renamePreview.pickFirst'));
      return api.media.apply(body);
    },
    onSuccess: (res) => {
      setPlan(res.plan);
      toast.success(
        t('renamePreview.appliedTitle'),
        t('renamePreview.appliedBody', { applied: res.applied, skipped: res.skipped, failed: res.failed }),
      );
    },
    onError: (err) => toast.error(t('renamePreview.applyFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const runApply = () => {
    if (!confirm(t('renamePreview.confirmExecute'))) return;
    apply.mutate();
  };

  const conflicts = conflictSet(plan ?? undefined);
  const hasConflicts = conflicts.size > 0;

  // A settled library is almost entirely files already at their destination. Listing
  // them buries the few that actually move — one live show planned 322 rows of which
  // 10 were real work — so they are collapsed behind a count by default.
  const unchangedCount = (plan?.items ?? []).filter((i) => i.unchanged).length;
  const visibleItems = (plan?.items ?? []).filter((i) => showUnchanged || !i.unchanged);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          {t('common.backToManager')}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('renamePreview.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('renamePreview.subtitle')}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          {librariesQuery.isLoading ? (
            <CenteredSpinner label={t('renamePreview.loadingLibraries')} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="rp-library">{t('renamePreview.field.library')}</Label>
                  <Select
                    id="rp-library"
                    value={libraryId}
                    onChange={(e) => setLibraryId(e.target.value)}
                    options={libraryOptions}
                  />
                </div>
                <div>
                  <Label htmlFor="rp-source">{t('renamePreview.field.source')}</Label>
                  <PathPicker
                    id="rp-source"
                    value={sourcePath}
                    onChange={setSourcePath}
                    placeholder={t('renamePreview.field.sourcePlaceholder')}
                    aria-label={t('renamePreview.field.sourceAria')}
                    pickerTitle={t('renamePreview.field.sourcePicker')}
                  />
                </div>
              </div>

              {library && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('renamePreview.target')}</span>
                  <Badge variant="info">{presetLabel(t, library.preset)}</Badge>
                  <Badge variant="outline">{modeLabel(t, library.mode)}</Badge>
                  <span className="font-mono">{library.path}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                <div className="flex items-center gap-2">
                  <Switch id="rp-dryrun" checked={dryRun} onCheckedChange={setDryRun} />
                  <Label htmlFor="rp-dryrun" className="cursor-pointer">
                    {t('renamePreview.dryRun')}
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => preview.mutate()}
                    loading={preview.isPending}
                    disabled={!library || !sourcePath.trim()}
                  >
                    <Play className="h-4 w-4" /> {t('renamePreview.previewBtn')}
                  </Button>
                  {canApply && (
                    <Button
                      onClick={runApply}
                      loading={apply.isPending}
                      disabled={dryRun || !plan || plan.items.length === 0 || hasConflicts}
                    >
                      <Save className="h-4 w-4" /> {t('renamePreview.executeBtn')}
                    </Button>
                  )}
                </div>
              </div>
              {canApply && dryRun && (
                <p className="text-xs text-muted-foreground">
                  {t('renamePreview.dryRunHint')}
                </p>
              )}
              {canApply && hasConflicts && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> {t('renamePreview.conflictHint')}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {plan && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{t('renamePreview.plan')}</p>
              <Badge variant="info">{presetLabel(t, plan.preset)}</Badge>
              <Badge variant="outline">{modeLabel(t, plan.mode)}</Badge>
              <span className="text-xs text-muted-foreground">
                {t('common.items', { count: visibleItems.length })}
              </span>
              {hasConflicts && <Badge variant="destructive">{t('renamePreview.conflicts', { count: conflicts.size })}</Badge>}
              {unchangedCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setShowUnchanged((v) => !v)}
                >
                  {showUnchanged
                    ? t('renamePreview.hideUnchanged', { count: unchangedCount })
                    : t('renamePreview.showUnchanged', { count: unchangedCount })}
                </Button>
              )}
            </div>

            {plan.warnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                {plan.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            {visibleItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {unchangedCount > 0 ? t('renamePreview.allInPlace') : t('common.noFilesToRename')}
              </p>
            ) : (
              <div className="space-y-2">
                {visibleItems.map((item, i) => {
                  const isConflict = item.destination != null && conflicts.has(item.destination);
                  return (
                    <div
                      key={i}
                      className={cn(
                        'rounded-md border p-3',
                        isConflict
                          ? 'border-destructive/50 bg-destructive/5'
                          : 'border-border/60',
                        (item.skipped || item.unchanged) && 'opacity-60',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={item.skipped || item.unchanged ? 'secondary' : 'success'}>{item.action}</Badge>
                        {item.unchanged && <Badge variant="outline">{t('renamePreview.badge.unchanged')}</Badge>}
                        {item.isSubtitle && <Badge variant="outline">{t('renamePreview.badge.subtitle')}</Badge>}
                        {item.isSample && <Badge variant="warning">{t('renamePreview.badge.sample')}</Badge>}
                        {isConflict && <Badge variant="destructive">{t('renamePreview.badge.conflict')}</Badge>}
                        {item.reason && <span className="text-xs text-muted-foreground">{item.reason}</span>}
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{item.source}</p>
                      {item.destination && (
                        <p className="mt-0.5 break-all font-mono text-xs text-foreground/80">
                          → {item.destination}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
