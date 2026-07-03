import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const { hasPermission } = useAuth();
  const canApply = hasPermission(PERMISSIONS.MEDIA_MANAGER_RENAME);

  const librariesQuery = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.libraries });

  const [libraryId, setLibraryId] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [plan, setPlan] = useState<RenamePlan | null>(null);

  const libraries = librariesQuery.data ?? [];
  const library: MediaLibrary | undefined = libraries.find((l) => l.id === libraryId);

  const libraryOptions = useMemo(
    () => [
      { value: '', label: 'Select a library…' },
      ...libraries.map((l) => ({ value: l.id, label: `${l.name} (${l.path})` })),
    ],
    [libraries],
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
      if (!body) throw new ApiError(400, 'Pick a library and a source path first.');
      return api.media.preview(body);
    },
    onSuccess: (result) => setPlan(result),
    onError: (err) => toast.error('Preview failed', err instanceof ApiError ? err.message : undefined),
  });

  const apply = useMutation({
    mutationFn: () => {
      const body = buildBody();
      if (!body) throw new ApiError(400, 'Pick a library and a source path first.');
      return api.media.apply(body);
    },
    onSuccess: (res) => {
      setPlan(res.plan);
      toast.success(
        'Rename applied',
        `${res.applied} applied, ${res.skipped} skipped, ${res.failed} failed.`,
      );
    },
    onError: (err) => toast.error('Apply failed', err instanceof ApiError ? err.message : undefined),
  });

  const runApply = () => {
    if (!confirm('Execute this rename plan on disk?')) return;
    apply.mutate();
  };

  const conflicts = conflictSet(plan ?? undefined);
  const hasConflicts = conflicts.size > 0;

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          Media Manager
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Rename Preview</h1>
        <p className="text-sm text-muted-foreground">
          Preview how a source folder would be reorganized into a library’s layout, then execute when
          it looks right.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          {librariesQuery.isLoading ? (
            <CenteredSpinner label="Loading libraries…" />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="rp-library">Library</Label>
                  <Select
                    id="rp-library"
                    value={libraryId}
                    onChange={(e) => setLibraryId(e.target.value)}
                    options={libraryOptions}
                  />
                </div>
                <div>
                  <Label htmlFor="rp-source">Source path</Label>
                  <PathPicker
                    id="rp-source"
                    value={sourcePath}
                    onChange={setSourcePath}
                    placeholder="/downloads/Show.Name.S01"
                    aria-label="Source path"
                    pickerTitle="Choose the source folder"
                  />
                </div>
              </div>

              {library && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Target:</span>
                  <Badge variant="info">{presetLabel(library.preset)}</Badge>
                  <Badge variant="outline">{modeLabel(library.mode)}</Badge>
                  <span className="font-mono">{library.path}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                <div className="flex items-center gap-2">
                  <Switch id="rp-dryrun" checked={dryRun} onCheckedChange={setDryRun} />
                  <Label htmlFor="rp-dryrun" className="cursor-pointer">
                    Dry run (preview only)
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => preview.mutate()}
                    loading={preview.isPending}
                    disabled={!library || !sourcePath.trim()}
                  >
                    <Play className="h-4 w-4" /> Preview
                  </Button>
                  {canApply && (
                    <Button
                      onClick={runApply}
                      loading={apply.isPending}
                      disabled={dryRun || !plan || plan.items.length === 0 || hasConflicts}
                    >
                      <Save className="h-4 w-4" /> Execute
                    </Button>
                  )}
                </div>
              </div>
              {canApply && dryRun && (
                <p className="text-xs text-muted-foreground">
                  Turn off “Dry run” to enable Execute.
                </p>
              )}
              {canApply && hasConflicts && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> Resolve destination conflicts before
                  executing.
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
              <p className="text-sm font-semibold">Plan</p>
              <Badge variant="info">{presetLabel(plan.preset)}</Badge>
              <Badge variant="outline">{modeLabel(plan.mode)}</Badge>
              <span className="text-xs text-muted-foreground">
                {plan.items.length} item{plan.items.length === 1 ? '' : 's'}
              </span>
              {hasConflicts && <Badge variant="destructive">{conflicts.size} conflict(s)</Badge>}
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
                {plan.items.map((item, i) => {
                  const isConflict = item.destination != null && conflicts.has(item.destination);
                  return (
                    <div
                      key={i}
                      className={cn(
                        'rounded-md border p-3',
                        isConflict
                          ? 'border-destructive/50 bg-destructive/5'
                          : 'border-border/60',
                        item.skipped && 'opacity-60',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={item.skipped ? 'secondary' : 'success'}>{item.action}</Badge>
                        {item.isSubtitle && <Badge variant="outline">subtitle</Badge>}
                        {item.isSample && <Badge variant="warning">sample</Badge>}
                        {isConflict && <Badge variant="destructive">conflict</Badge>}
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
