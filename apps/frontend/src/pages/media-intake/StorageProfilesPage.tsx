import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, HardDrive, Plus, Trash2, Activity } from 'lucide-react';
import { api, ApiError, type StorageProfile, type StorageCapabilityProbe } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STRATEGIES = ['auto', 'hardlink', 'reflink', 'provider_relocation', 'copy', 'move'];

/**
 * Storage profiles — where Media Intake stages, and which libraries it feeds.
 *
 * A profile names the roots intake owns and POINTS AT existing libraries rather
 * than restating their paths, so this screen picks libraries from a list and
 * only asks for a staging root.
 *
 * The capability probe is the part worth having on screen. Whether an import is
 * an instant hardlink or a 40 GB copy is decided by facts about the filesystem
 * that nobody can see from a path, and an operator who cannot check them finds
 * out by watching disk usage.
 */
export function StorageProfilesPage() {
  const { t } = useTranslation('intake');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [probes, setProbes] = useState<Record<string, StorageCapabilityProbe>>({});

  const profiles = useQuery({ queryKey: ['intake', 'profiles'], queryFn: () => api.intake.profiles() });
  const libraries = useQuery({ queryKey: ['media', 'libraries'], queryFn: () => api.media.listLibraries() });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['intake', 'profiles'] });

  const create = useMutation({
    mutationFn: (body: Partial<StorageProfile>) => api.intake.createProfile(body),
    onSuccess: () => { toast.success(t('profile.created')); setCreating(false); invalidate(); },
    onError: (e) => toast.error(t('profile.createFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<StorageProfile> }) =>
      api.intake.updateProfile(id, body),
    onSuccess: () => { toast.success(t('profile.saved')); invalidate(); },
    onError: (e) => toast.error(t('profile.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.intake.deleteProfile(id),
    onSuccess: () => { toast.success(t('profile.deleted')); invalidate(); },
    // The server refuses when rules still point here, and names how many.
    onError: (e) => toast.error(t('profile.deleteFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const probe = useMutation({
    mutationFn: (id: string) => api.intake.probeProfile(id),
    onSuccess: (result, id) => {
      setProbes((p) => ({ ...p, [id]: result }));
      if (result.error) toast.error(t('profile.probeFailed'), result.error);
    },
    onError: (e) => toast.error(t('profile.probeFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (profiles.isLoading) return <div className="p-6"><CenteredSpinner label={t('profile.loading')} /></div>;
  if (profiles.isError) {
    return (
      <div className="p-6">
        <ErrorState message={t('profile.loadFailed')} onRetry={() => profiles.refetch()} />
      </div>
    );
  }

  const libs = libraries.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media/settings')}>
          <ArrowLeft className="h-4 w-4" /> {t('profile.back')}
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <HardDrive className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">{t('profile.title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('profile.subtitle')}</p>
      </div>

      {!profiles.data?.length && !creating && (
        <EmptyState
          icon={<HardDrive className="h-6 w-6" />}
          title={t('profile.emptyTitle')}
          description={t('profile.emptyBody')}
        />
      )}

      {profiles.data?.map((p) => (
        <ProfileCard
          key={p.id}
          profile={p}
          libraries={libs}
          probe={probes[p.id]}
          probing={probe.isPending}
          onProbe={() => probe.mutate(p.id)}
          onSave={(body) => update.mutate({ id: p.id, body })}
          onDelete={() => {
            if (window.confirm(t('profile.deleteConfirm', { name: p.name }))) remove.mutate(p.id);
          }}
          saving={update.isPending}
        />
      ))}

      {creating ? (
        <ProfileCard
          libraries={libs}
          onSave={(body) => create.mutate(body)}
          onCancel={() => setCreating(false)}
          saving={create.isPending}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('profile.addBtn')}
          </Button>
          {/* Only offered once a profile exists — the wizard has nowhere to stage
              without one, and every rule would come back "No profile". */}
          {!!profiles.data?.length && (
            <Button variant="outline" onClick={() => navigate('/media/settings/intake/migrate')}>
              {t('migrate.title')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One profile, editable in place. Also used blank for creation. */
function ProfileCard({
  profile, libraries, probe, probing, onProbe, onSave, onDelete, onCancel, saving,
}: {
  profile?: StorageProfile;
  libraries: Array<{ id: string; name: string; kind: string }>;
  probe?: StorageCapabilityProbe;
  probing?: boolean;
  onProbe?: () => void;
  onSave: (body: Partial<StorageProfile>) => void;
  onDelete?: () => void;
  onCancel?: () => void;
  saving?: boolean;
}) {
  const { t } = useTranslation('intake');
  // A staging root usually does not exist yet — it is a directory the operator
  // is inventing for this profile. Offer to create it rather than saving a
  // profile that points at nothing and only fails at the first import.
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const [form, setForm] = useState({
    name: profile?.name ?? '',
    stagingRoot: profile?.stagingRoot ?? '',
    movieLibraryId: profile?.movieLibraryId ?? '',
    tvLibraryId: profile?.tvLibraryId ?? '',
    musicLibraryId: profile?.musicLibraryId ?? '',
    defaultStrategy: profile?.defaultStrategy ?? 'auto',
    isDefault: profile?.isDefault ?? false,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const libOptions = (kind: string) => [
    { value: '', label: t('profile.noLibrary') },
    ...libraries.filter((l) => l.kind === kind || kind === 'any').map((l) => ({ value: l.id, label: l.name })),
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`n-${profile?.id ?? 'new'}`}>{t('profile.name')}</Label>
            <Input id={`n-${profile?.id ?? 'new'}`} value={form.name}
              onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`s-${profile?.id ?? 'new'}`}>{t('profile.stagingRoot')}</Label>
            {/* Browse rather than type. A staging root is a path on the SERVER,
                which the person filling this in generally cannot see — and a
                typo here is not a validation error, it is an import pipeline
                that stages into a directory nothing else knows about. */}
            <PathPicker
              id={`s-${profile?.id ?? 'new'}`}
              value={form.stagingRoot}
              onChange={(v) => set('stagingRoot', v)}
              // The backend runs in a container, so this is a path in ITS
              // filesystem (`/downloads/…` by default), not the host's. Browsing
              // is rooted at FILE_MANAGER_ROOTS and so always yields that form.
              placeholder="/downloads/Staging"
              aria-label={t('profile.stagingRoot')}
              pickerTitle={t('profile.stagingPicker')}
            />
            <p className="text-xs text-muted-foreground">{t('profile.stagingHelp')}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {([['movieLibraryId', 'movie'], ['tvLibraryId', 'tv'], ['musicLibraryId', 'music']] as const)
            .map(([key, kind]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`${key}-${profile?.id ?? 'new'}`}>{t(`profile.${key}`)}</Label>
                <Select
                  id={`${key}-${profile?.id ?? 'new'}`}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  options={libOptions(kind)}
                />
              </div>
            ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`str-${profile?.id ?? 'new'}`}>{t('profile.strategy')}</Label>
            <Select
              id={`str-${profile?.id ?? 'new'}`}
              value={form.defaultStrategy}
              onChange={(e) => set('defaultStrategy', e.target.value)}
              options={STRATEGIES.map((s) => ({ value: s, label: t(`strategy.${s}` as never) }))}
            />
            {/* `move` is the only strategy that ends seeding, and it is never
                chosen automatically — so say so where it can be chosen. */}
            <p className="text-xs text-muted-foreground">
              {form.defaultStrategy === 'move' ? t('profile.moveWarning') : t('profile.strategyHelp')}
            </p>
          </div>

          {/* This existed in the form state and was posted on save, but had no
              control — so every profile was created non-default, and a managed
              rule that did not name a profile explicitly resolved nothing and
              quietly imported nothing. */}
          <div className="space-y-1.5">
            <Label htmlFor={`d-${profile?.id ?? 'new'}`}>{t('profile.isDefault')}</Label>
            <div className="flex items-center gap-2 pt-1.5">
              <Switch
                id={`d-${profile?.id ?? 'new'}`}
                checked={form.isDefault}
                onCheckedChange={(v) => set('isDefault', v)}
              />
              <span className="text-xs text-muted-foreground">{t('profile.isDefaultHelp')}</span>
            </div>
          </div>
        </div>

        {probe && (
          <div className="rounded-md border border-border/60 p-3">
            <p className="text-sm font-medium">{t('profile.capabilities')}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(['sameDevice', 'hardlink', 'reflink', 'symlink', 'providerRelocation'] as const).map((k) => (
                <Badge key={k} variant={probe[k] ? 'success' : 'secondary'}>
                  {t(`capability.${k}` as never)}: {probe[k] ? t('yes') : t('no')}
                </Badge>
              ))}
              {probe.filesystem && <Badge variant="secondary">{probe.filesystem}</Badge>}
            </div>
            {/* Measured, in words — what an operator reads when a strategy surprises them. */}
            <p className="mt-2 text-xs text-muted-foreground">{probe.detail}</p>
            {probe.error && <p className="mt-1 text-xs text-destructive">{probe.error}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              // Aborts on a path outside the ops hard roots, or if the operator
              // declines to create a missing one.
              if (!(await ensureDirectory(form.stagingRoot))) return;
              onSave({
                ...form,
                movieLibraryId: form.movieLibraryId || null,
                tvLibraryId: form.tvLibraryId || null,
                musicLibraryId: form.musicLibraryId || null,
              });
            }}
            disabled={!form.name.trim() || !form.stagingRoot.trim() || saving}
            loading={saving}
          >
            {profile ? t('profile.saveBtn') : t('profile.createBtn')}
          </Button>
          {profile && onProbe && (
            <Button variant="outline" onClick={onProbe} loading={probing}>
              <Activity className="h-4 w-4" /> {t('profile.probeBtn')}
            </Button>
          )}
          {onCancel && <Button variant="ghost" onClick={onCancel}>{t('profile.cancel')}</Button>}
          {onDelete && (
            <Button variant="destructive" onClick={onDelete} className="ml-auto">
              <Trash2 className="h-4 w-4" /> {t('profile.deleteBtn')}
            </Button>
          )}
        </div>
        {ensureDirectoryDialog}
      </CardContent>
    </Card>
  );
}
