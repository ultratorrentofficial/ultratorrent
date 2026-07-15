import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Languages, RefreshCw, Save } from 'lucide-react';
import { api, type SubtitleLanguageSettings } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const toList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const fromList = (a: string[] | undefined): string => (a ?? []).join(', ');

function LibraryForm({ libraryId, canEdit }: { libraryId: string; canEdit: boolean }) {
  const { t } = useTranslation('subtitleIntelligence');
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['subtitles', 'languages', libraryId],
    queryFn: () => api.subtitles.getLanguages(libraryId),
  });

  const [form, setForm] = useState<SubtitleLanguageSettings | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.subtitles.setLanguages(libraryId, form ?? {}),
    onSuccess: () => {
      toast.success(t('languages.saved'));
      void qc.invalidateQueries({ queryKey: ['subtitles', 'languages', libraryId] });
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  if (isLoading || !form) return <CenteredSpinner label={t('common.loading')} />;
  if (isError) return <ErrorState title={t('common.error')} onRetry={() => refetch()} />;

  const set = <K extends keyof SubtitleLanguageSettings>(k: K, v: SubtitleLanguageSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="required">{t('languages.required')}</Label>
            <Input id="required" value={fromList(form.requiredLanguages)} onChange={(e) => set('requiredLanguages', toList(e.target.value))} placeholder="en, es" disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="preferred">{t('languages.preferred')}</Label>
            <Input id="preferred" value={fromList(form.preferredLanguages)} onChange={(e) => set('preferredLanguages', toList(e.target.value))} placeholder="en" disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="forced">{t('languages.forced')}</Label>
            <Input id="forced" value={fromList(form.forcedLanguages)} onChange={(e) => set('forcedLanguages', toList(e.target.value))} placeholder="en" disabled={!canEdit} />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="providers">{t('languages.preferredProviders')}</Label>
            <Input id="providers" value={fromList(form.preferredProviders)} onChange={(e) => set('preferredProviders', toList(e.target.value))} placeholder="opensubtitles, subdl, local" disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="minScore">{t('languages.minScore')}</Label>
            <Input id="minScore" type="number" value={String(form.minimumScore)} onChange={(e) => set('minimumScore', Number(e.target.value) || 0)} disabled={!canEdit} />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ['hearingImpaired', t('languages.hearingImpaired')],
            ['machineTranslation', t('languages.machineTranslation')],
            ['synchronizationRequired', t('languages.syncRequired')],
            ['automaticReplacement', t('languages.autoReplace')],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span>{label}</span>
              <Switch checked={form[key] as boolean} onCheckedChange={(v) => set(key, v as never)} disabled={!canEdit} />
            </label>
          ))}
        </div>

        {canEdit && (
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            <Save className="mr-1 h-4 w-4" /> {t('common.save')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function SubtitleLanguagesPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_SETTINGS);
  const canScan = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_SEARCH);

  const libraries = useQuery({ queryKey: ['media', 'libraries'], queryFn: () => api.media.libraries() });
  const [libraryId, setLibraryId] = useState<string>('');

  const scan = useMutation({
    mutationFn: () => api.subtitles.scanMissing(libraryId),
    onSuccess: () => toast.success(t('languages.scanStarted')),
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  useEffect(() => {
    if (!libraryId && libraries.data?.length) setLibraryId(libraries.data[0].id);
  }, [libraries.data, libraryId]);

  if (libraries.isLoading) return <CenteredSpinner label={t('common.loading')} />;
  if (libraries.isError) return <ErrorState title={t('common.error')} onRetry={() => libraries.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Languages className="h-6 w-6 text-primary" /> {t('languages.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('languages.subtitle')}</p>
      </div>

      {(libraries.data?.length ?? 0) === 0 ? (
        <EmptyState icon={<Languages className="h-6 w-6" />} title={t('languages.noLibraries')} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="max-w-xs flex-1">
              <Label htmlFor="lib">{t('languages.selectLibrary')}</Label>
              <Select
                id="lib"
                value={libraryId}
                onChange={(e) => setLibraryId(e.target.value)}
                options={libraries.data!.map((l) => ({ value: l.id, label: l.name }))}
              />
            </div>
            {canScan && libraryId && (
              <Button variant="outline" onClick={() => scan.mutate()} loading={scan.isPending}>
                <RefreshCw className="mr-1 h-4 w-4" /> {t('languages.scanMissing')}
              </Button>
            )}
          </div>
          {libraryId && <LibraryForm libraryId={libraryId} canEdit={canEdit} />}
        </>
      )}
    </div>
  );
}
