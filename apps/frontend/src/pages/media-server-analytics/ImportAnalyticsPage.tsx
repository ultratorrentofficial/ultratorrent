import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, type AnalyticsImportPreview } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const JOB_VARIANT: Record<string, BadgeProps['variant']> = {
  completed: 'success',
  running: 'info',
  pending: 'secondary',
  failed: 'destructive',
  cancelled: 'secondary',
};

export function ImportAnalyticsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: 'Tautulli', baseUrl: '', apiKey: '' });
  const [preview, setPreview] = useState<Record<string, AnalyticsImportPreview>>({});

  const sources = useQuery({ queryKey: ['msa', 'import-sources'], queryFn: () => api.mediaServerAnalytics.importSources() });
  const jobs = useQuery({
    queryKey: ['msa', 'import-jobs'],
    queryFn: () => api.mediaServerAnalytics.importJobs(),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.status === 'running' || j.status === 'pending') ? 2000 : false),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['msa', 'import-sources'] });
    void queryClient.invalidateQueries({ queryKey: ['msa', 'import-jobs'] });
  };

  const create = useMutation({
    mutationFn: () => api.mediaServerAnalytics.createImportSource({ name: form.name.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }),
    onSuccess: () => { setForm({ name: 'Tautulli', baseUrl: '', apiKey: '' }); invalidate(); },
    onError: (e) => toast.error(t('import.testFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.testImportSource(id),
    onSuccess: (r) => (r.ok ? toast.success(t('import.tested'), r.message) : toast.error(t('import.testFailed'), r.message)),
    onError: (e) => toast.error(t('import.testFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const doPreview = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.previewImport(id),
    onError: (e) => toast.error(t('import.previewFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const runImport = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.runImport(id),
    onSuccess: () => { toast.success(t('import.started')); invalidate(); },
    onError: (e) => toast.error(t('import.importFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.deleteImportSource(id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('import.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('import.subtitle')}</p>
      </div>

      {sources.isLoading ? (
        <CenteredSpinner />
      ) : sources.isError ? (
        <ErrorState title={t('import.loadError')} onRetry={() => void sources.refetch()} />
      ) : (
        <>
          {(sources.data ?? []).map((s) => (
            <Card key={s.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.baseUrl}</span>
                  {s.status && <Badge variant={s.status === 'connected' || s.status === 'imported' ? 'success' : 'secondary'}>{s.status}</Badge>}
                  <span className="flex-1" />
                  <Button variant="secondary" size="sm" onClick={() => test.mutate(s.id)} disabled={test.isPending}>
                    <RefreshCw className="h-3.5 w-3.5" />{t('import.test')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => doPreview.mutate(s.id, { onSuccess: (p) => setPreview((prev) => ({ ...prev, [s.id]: p })) })} disabled={doPreview.isPending}>
                    <Download className="h-3.5 w-3.5" />{t('import.previewBtn')}
                  </Button>
                  <Button size="sm" onClick={() => runImport.mutate(s.id)} disabled={runImport.isPending || !s.hasApiKey}>
                    <Play className="h-3.5 w-3.5" />{t('import.import')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(s.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {preview[s.id] && (
                  <div className="flex gap-4 text-sm text-muted-foreground">
                    <span>{t('import.preview.users')}: {preview[s.id].totalUsers}</span>
                    <span>{t('import.preview.history')}: {preview[s.id].totalHistory}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {(sources.data ?? []).length === 0 && <EmptyState title={t('import.noSource')} />}

          {/* Add-source form */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('import.add.title')}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="imp-name">{t('import.add.name')}</Label>
                  <Input id="imp-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="imp-url">{t('import.add.url')}</Label>
                  <Input id="imp-url" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="http://tautulli.local:8181" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="imp-key">{t('import.add.apiKey')}</Label>
                  <Input id="imp-key" type="password" value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
                </div>
              </div>
              <Button onClick={() => create.mutate()} disabled={!form.baseUrl.trim() || create.isPending}>
                {t('import.add.submit')}
              </Button>
            </CardContent>
          </Card>

          {/* Import jobs */}
          <div>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t('import.jobs')}</h2>
            {(jobs.data ?? []).length === 0 ? (
              <EmptyState title={t('import.noJobs')} />
            ) : (
              <ul className="space-y-2">
                {jobs.data!.map((j) => (
                  <li key={j.id}>
                    <Card>
                      <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
                        <Badge variant={JOB_VARIANT[j.status] ?? 'secondary'}>{j.status}</Badge>
                        <span className="text-muted-foreground">{t('import.job.imported')}: {j.importedRecords}</span>
                        <span className="text-muted-foreground">{t('import.job.skipped')}: {j.skippedRecords}</span>
                        <span className="flex-1" />
                        {j.status === 'running' && <Progress value={j.progress / 100} className="w-40" />}
                        <span className="tabular-nums text-muted-foreground">{j.progress}%</span>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
