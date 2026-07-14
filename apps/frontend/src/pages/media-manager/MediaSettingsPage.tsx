import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  Image as ImageIcon,
  Pencil,
  Film,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Subtitles,
  Trash2,
  Users,
  Wand2,
} from 'lucide-react';
import {
  ApiError,
  api,
  type MediaProviderChains,
  type MediaServerIntegration,
  type TraktDeviceCode,
  type TraktSyncSettings,
  type MediaServerIntegrationInput,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
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
import { artworkTypeLabel, mediaServerKindLabel, mediaServerKindOptions } from './constants';

export function MediaSettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManageIntegrations = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_INTEGRATIONS);
  const canViewImdb = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          {t('common.backToManager')}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('settings.subtitle')}
        </p>
      </div>

      <MetadataProvidersSection />
      {canViewImdb && (
        <SectionCard
          icon={<Film className="h-5 w-5" />}
          title={t('settings.imdb.title')}
          description={t('settings.imdb.description')}
          actions={
            <Button size="sm" variant="outline" onClick={() => navigate('/media/settings/imdb')}>
              {t('settings.imdb.configureBtn')}
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t('settings.imdb.body')}
          </p>
        </SectionCard>
      )}
      <TraktSection />
      <ArtworkPreferencesSection />
      <SubtitlePreferencesSection />
      <RenameTemplatesSection />
      <CleanupRulesSection />
      {canManageIntegrations ? (
        <IntegrationsSection />
      ) : (
        <SectionCard icon={<Plug className="h-5 w-5" />} title={t('settings.integrations.noPermTitle')}>
          <p className="text-sm text-muted-foreground">
            {t('settings.integrations.noPermBody')}
          </p>
        </SectionCard>
      )}
    </div>
  );
}

function SectionCard({
  icon,
  title,
  description,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** A single-key setting editor backed by the generic settings KV store. */
function useSettingField(key: string) {
  const { hasPermission } = useAuth();
  const canView = hasPermission(PERMISSIONS.SETTINGS_VIEW);
  const canManage = hasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('media');

  const query = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    enabled: canView,
  });

  const save = useMutation({
    mutationFn: (value: string) => api.settings.update({ [key]: value }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  const stored = canView ? ((query.data?.[key] as string | undefined) ?? '') : '';
  return { canView, canManage, stored, isLoading: query.isLoading, save };
}

function MetadataProvidersSection() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const tmdb = useSettingField('media.tmdbApiKey');
  const tvdb = useSettingField('media.tvdbApiKey');
  const tvdbPin = useSettingField('media.tvdbPin');

  const [tmdbValue, setTmdbValue] = useState('');
  const [tvdbValue, setTvdbValue] = useState('');
  const [pinValue, setPinValue] = useState('');
  const [testing, setTesting] = useState<'tmdb' | 'tvdb' | null>(null);

  useEffect(() => setTmdbValue(tmdb.stored), [tmdb.stored]);
  useEffect(() => setTvdbValue(tvdb.stored), [tvdb.stored]);
  useEffect(() => setPinValue(tvdbPin.stored), [tvdbPin.stored]);

  const canView = tmdb.canView;
  const canManage = tmdb.canManage;
  const isLoading = tmdb.isLoading || tvdb.isLoading;

  // Which providers are live, and who gets asked first. Shown because the chain
  // is the whole point of having two keys — without it, an operator can't tell
  // whether their TVDB key is actually being used for TV.
  const chains = useQuery({
    queryKey: ['media', 'providers'],
    queryFn: () => api.media.metadataProviders(),
    enabled: canView,
  });

  // Test the key currently in the box; an empty box makes the server fall back
  // to the saved key, so the button also validates an already-saved one.
  const runTest = async (which: 'tmdb' | 'tvdb') => {
    setTesting(which);
    try {
      const res =
        which === 'tmdb'
          ? await api.media.testTmdbKey(tmdbValue.trim() || undefined)
          : await api.media.testTvdbKey(tvdbValue.trim() || undefined, pinValue.trim() || undefined);
      if (res.ok) toast.success(t('settings.metadata.testOkTitle'), res.message);
      else toast.error(t('settings.metadata.testFailTitle'), res.message);
    } catch (err) {
      toast.error(
        t('settings.metadata.testFailTitle'),
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setTesting(null);
    }
  };

  const saveTvdb = () => {
    tvdb.save.mutate(tvdbValue.trim());
    tvdbPin.save.mutate(pinValue.trim());
  };

  return (
    <SectionCard
      icon={<KeyRound className="h-5 w-5" />}
      title={t('settings.metadata.title')}
      description={t('settings.metadata.description')}
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">
          {t('settings.metadata.noViewPerm')}
        </p>
      ) : isLoading ? (
        <CenteredSpinner label={t('settings.metadata.loading')} />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[280px] flex-1">
              <Label htmlFor="tmdb-key">{t('settings.metadata.keyLabel')}</Label>
              <Input
                id="tmdb-key"
                type="password"
                value={tmdbValue}
                onChange={(e) => setTmdbValue(e.target.value)}
                placeholder={t('settings.metadata.keyPlaceholder')}
                disabled={!canManage}
                autoComplete="off"
              />
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void runTest('tmdb')}
                  loading={testing === 'tmdb'}
                  disabled={tmdb.save.isPending}
                >
                  <Plug className="h-4 w-4" /> {t('settings.metadata.testKey')}
                </Button>
                <Button onClick={() => tmdb.save.mutate(tmdbValue.trim())} loading={tmdb.save.isPending}>
                  <Save className="h-4 w-4" /> {t('common.save')}
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border/60 pt-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <Label htmlFor="tvdb-key">{t('settings.metadata.tvdbKeyLabel')}</Label>
                <Input
                  id="tvdb-key"
                  type="password"
                  value={tvdbValue}
                  onChange={(e) => setTvdbValue(e.target.value)}
                  placeholder={t('settings.metadata.tvdbKeyPlaceholder')}
                  disabled={!canManage}
                  autoComplete="off"
                />
              </div>
              <div className="w-[160px]">
                <Label htmlFor="tvdb-pin">{t('settings.metadata.tvdbPinLabel')}</Label>
                <Input
                  id="tvdb-pin"
                  type="password"
                  value={pinValue}
                  onChange={(e) => setPinValue(e.target.value)}
                  placeholder={t('settings.metadata.tvdbPinPlaceholder')}
                  disabled={!canManage}
                  autoComplete="off"
                />
              </div>
              {canManage && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void runTest('tvdb')}
                    loading={testing === 'tvdb'}
                    disabled={tvdb.save.isPending}
                  >
                    <Plug className="h-4 w-4" /> {t('settings.metadata.testKey')}
                  </Button>
                  <Button onClick={saveTvdb} loading={tvdb.save.isPending || tvdbPin.save.isPending}>
                    <Save className="h-4 w-4" /> {t('common.save')}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.metadata.tvdbHint')}</p>
          </div>

          <div className="border-t border-border/60 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('settings.metadata.chainLabel')}
            </p>
            {chains.data && chains.data.configured.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-4 text-sm">
                <span>
                  {t('settings.metadata.chainTv')}:{' '}
                  <span className="font-mono">{chains.data.chains.tv.join(' → ')}</span>
                </span>
                <span>
                  {t('settings.metadata.chainMovie')}:{' '}
                  <span className="font-mono">{chains.data.chains.movie.join(' → ')}</span>
                </span>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('settings.metadata.chainNone')}
              </p>
            )}
          </div>

          {chains.data && (
            <UniversalScraperPanel
              state={chains.data}
              canManage={canManage}
              onSaved={() => void chains.refetch()}
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * The Universal scraper: compose one record per item from every configured
 * provider, choosing a preferred source per field.
 *
 * `auto` (the default for every field) means "take it from whoever has it, in
 * chain order" — which is what most people want. A named provider is a
 * *preference*, not a restriction: if it has nothing for that field, the value
 * still comes from the chain rather than coming back empty.
 */
function UniversalScraperPanel({
  state,
  canManage,
  onSaved,
}: {
  state: MediaProviderChains;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();

  const [enabled, setEnabled] = useState(state.universal.enabled);
  const [fields, setFields] = useState<Record<string, string>>(state.universal.fields ?? {});
  useEffect(() => {
    setEnabled(state.universal.enabled);
    setFields(state.universal.fields ?? {});
  }, [state.universal.enabled, state.universal.fields]);

  const save = useMutation({
    mutationFn: () =>
      api.settings.update({
        'media.universalScraper.enabled': enabled,
        // Drop `auto` rather than store it: an absent field IS auto, and writing
        // it back would freeze today's default into every install forever.
        'media.universalScraper.fields': Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v && v !== 'auto'),
        ),
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      onSaved();
    },
    onError: (err) =>
      toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  const providerOptions = [
    { value: 'auto', label: t('settings.universal.auto') },
    ...state.configured.map((p) => ({ value: p, label: p })),
  ];

  return (
    <div className="space-y-3 border-t border-border/60 pt-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="universal-toggle">{t('settings.universal.title')}</Label>
          <p className="mt-0.5 max-w-[62ch] text-xs text-muted-foreground">
            {t('settings.universal.description')}
          </p>
        </div>
        <Switch
          id="universal-toggle"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={!canManage}
        />
      </div>

      {/* Enabled but inert: say so plainly instead of letting the toggle imply
          something is happening. */}
      {enabled && state.configured.length < 2 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t('settings.universal.needsTwo')}
        </p>
      )}

      {enabled && state.configured.length > 1 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {state.universal.composableFields.map((field) => (
            <div key={field}>
              <Label htmlFor={`uni-${field}`} className="text-xs">
                {t(`settings.universal.field.${field}`, field)}
              </Label>
              <Select
                id={`uni-${field}`}
                value={fields[field] ?? 'auto'}
                onChange={(e) => setFields((f) => ({ ...f, [field]: e.target.value }))}
                disabled={!canManage}
                options={providerOptions}
              />
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <Save className="h-4 w-4" /> {t('common.save')}
        </Button>
      )}
    </div>
  );
}

/**
 * Trakt: the app credentials (operator-level), then a per-user account link via
 * the device flow — UltraTorrent is a server with no browser to redirect, so the
 * user takes a code to trakt.tv/activate and we poll until they approve it.
 */
function TraktSection() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const clientId = useSettingField('media.trakt.clientId');
  const clientSecret = useSettingField('media.trakt.clientSecret');

  const [idValue, setIdValue] = useState('');
  const [secretValue, setSecretValue] = useState('');
  useEffect(() => setIdValue(clientId.stored), [clientId.stored]);
  useEffect(() => setSecretValue(clientSecret.stored), [clientSecret.stored]);

  const [device, setDevice] = useState<TraktDeviceCode | null>(null);
  const [linking, setLinking] = useState(false);

  const status = useQuery({
    queryKey: ['media', 'trakt', 'status'],
    queryFn: () => api.media.traktStatus(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['media', 'trakt', 'status'] });

  const saveApp = () => {
    clientId.save.mutate(idValue.trim());
    clientSecret.save.mutate(secretValue.trim());
  };

  /**
   * Drive the device flow. The poll interval comes from Trakt (`intervalSec`) and
   * BACKS OFF on `slow_down` — polling through that is what gets an application
   * throttled, so the server's answer decides the cadence, not us.
   */
  const startLink = async () => {
    setLinking(true);
    try {
      const code = await api.media.traktStartDevice();
      setDevice(code);
      let intervalMs = Math.max(code.intervalSec, 1) * 1000;
      const deadline = Date.now() + code.expiresInSec * 1000;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const res = await api.media.traktPollDevice();
        if (res.status === 'authorized') {
          toast.success(t('settings.trakt.linkedTitle'), res.username ?? undefined);
          setDevice(null);
          refresh();
          return;
        }
        if (res.status === 'slow_down') {
          intervalMs += 1000; // Trakt asked us to back off — obey it
          continue;
        }
        if (res.status !== 'pending') {
          toast.error(t('settings.trakt.linkFailed'), t(`settings.trakt.poll.${res.status}`));
          setDevice(null);
          return;
        }
      }
      toast.error(t('settings.trakt.linkFailed'), t('settings.trakt.poll.expired'));
      setDevice(null);
    } catch (err) {
      toast.error(t('settings.trakt.linkFailed'), err instanceof ApiError ? err.message : undefined);
      setDevice(null);
    } finally {
      setLinking(false);
    }
  };

  const disconnect = useMutation({
    mutationFn: () => api.media.traktDisconnect(),
    onSuccess: () => {
      toast.success(t('settings.trakt.disconnected'));
      refresh();
    },
  });

  const updateSettings = useMutation({
    mutationFn: (patch: Partial<TraktSyncSettings>) => api.media.traktUpdateSettings(patch),
    onSuccess: () => refresh(),
    onError: (err) =>
      toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  const runSync = useMutation({
    mutationFn: (what: 'watchlist' | 'collection' | 'watched' | 'ratings' | 'backfill') =>
      api.media.traktSync(what),
    onSuccess: (summary) => {
      const parts = Object.entries(summary)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${t(`settings.trakt.summary.${k}`, k)}: ${v}`);
      toast.success(t('settings.trakt.syncDone'), parts.join(' · '));
      refresh();
    },
    onError: (err) =>
      toast.error(t('settings.trakt.syncFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const s = status.data;
  const settings = s?.settings;

  return (
    <SectionCard
      icon={<Users className="h-5 w-5" />}
      title={t('settings.trakt.title')}
      description={t('settings.trakt.description')}
    >
      {status.isLoading ? (
        <CenteredSpinner label={t('settings.metadata.loading')} />
      ) : (
        <div className="space-y-5">
          {/* The application credentials — one per install, registered by the operator. */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1">
              <Label htmlFor="trakt-id">{t('settings.trakt.clientId')}</Label>
              <Input
                id="trakt-id"
                type="password"
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                disabled={!clientId.canManage}
                autoComplete="off"
              />
            </div>
            <div className="min-w-[240px] flex-1">
              <Label htmlFor="trakt-secret">{t('settings.trakt.clientSecret')}</Label>
              <Input
                id="trakt-secret"
                type="password"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                disabled={!clientId.canManage}
                autoComplete="off"
              />
            </div>
            {clientId.canManage && (
              <Button onClick={saveApp} loading={clientId.save.isPending}>
                <Save className="h-4 w-4" /> {t('common.save')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.trakt.appHint')}</p>

          {/* The per-user account link. */}
          <div className="space-y-3 border-t border-border/60 pt-5">
            {!s?.configured ? (
              <p className="text-sm text-muted-foreground">{t('settings.trakt.notConfigured')}</p>
            ) : s.linked ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" dot>
                    {t('settings.trakt.linkedAs', { username: s.username ?? '—' })}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => disconnect.mutate()}
                    loading={disconnect.isPending}
                  >
                    {t('settings.trakt.disconnect')}
                  </Button>
                </div>
                {s.lastError && (
                  <p className="text-xs text-destructive">{s.lastError}</p>
                )}

                {/* Which media-server user's plays belong to this Trakt account.
                    Without it a scrobble cannot be attributed to anyone. */}
                <div className="max-w-sm">
                  <Label htmlFor="trakt-msuser">{t('settings.trakt.mediaServerUser')}</Label>
                  <Input
                    id="trakt-msuser"
                    defaultValue={settings?.mediaServerUserName ?? ''}
                    placeholder={t('settings.trakt.mediaServerUserPlaceholder')}
                    onBlur={(e) =>
                      updateSettings.mutate({ mediaServerUserName: e.target.value.trim() || null })
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('settings.trakt.mediaServerUserHint')}
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ['scrobbleEnabled', 'scrobble'],
                      ['syncWatched', 'watched'],
                      ['syncCollection', 'collection'],
                      ['syncRatings', 'ratings'],
                      ['syncWatchlist', 'watchlist'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                      <Label htmlFor={`trakt-${key}`} className="text-sm">
                        {t(`settings.trakt.toggle.${label}`)}
                      </Label>
                      <Switch
                        id={`trakt-${key}`}
                        checked={settings?.[key] ?? false}
                        onCheckedChange={(checked) => updateSettings.mutate({ [key]: checked })}
                      />
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  {(['watchlist', 'collection', 'watched', 'ratings', 'backfill'] as const).map((what) => (
                    <Button
                      key={what}
                      size="sm"
                      variant="outline"
                      onClick={() => runSync.mutate(what)}
                      loading={runSync.isPending && runSync.variables === what}
                    >
                      <RefreshCw className="h-4 w-4" /> {t(`settings.trakt.run.${what}`)}
                    </Button>
                  ))}
                </div>
              </>
            ) : device ? (
              // The device flow's whole UX: a code the user types on trakt.tv.
              <div className="space-y-2 rounded-md border border-border/60 p-4">
                <p className="text-sm">{t('settings.trakt.enterCode')}</p>
                <p className="font-mono text-2xl font-bold tracking-widest">{device.userCode}</p>
                <p className="text-sm text-muted-foreground">
                  {device.verificationUrl}
                </p>
                <p className="text-xs text-muted-foreground">{t('settings.trakt.waiting')}</p>
              </div>
            ) : (
              <Button onClick={() => void startLink()} loading={linking}>
                <Plug className="h-4 w-4" /> {t('settings.trakt.connect')}
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ArtworkPreferencesSection() {
  const { t } = useTranslation('media');
  const { canView, canManage, stored, isLoading, save } = useSettingField('media.artwork.preferredType');
  const [value, setValue] = useState('poster');
  useEffect(() => {
    if (stored) setValue(stored);
  }, [stored]);

  return (
    <SectionCard
      icon={<ImageIcon className="h-5 w-5" />}
      title={t('settings.artworkPref.title')}
      description={t('settings.artworkPref.description')}
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">{t('settings.requiresSettings')}</p>
      ) : isLoading ? (
        <CenteredSpinner label={t('settings.metadata.loading')} />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <Label htmlFor="art-pref">{t('settings.artworkPref.label')}</Label>
            <Select
              id="art-pref"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={!canManage}
              options={[
                { value: 'poster', label: artworkTypeLabel(t, 'poster') },
                { value: 'fanart', label: artworkTypeLabel(t, 'fanart') },
                { value: 'banner', label: artworkTypeLabel(t, 'banner') },
                { value: 'thumbnail', label: artworkTypeLabel(t, 'thumbnail') },
              ]}
            />
          </div>
          {canManage && (
            <Button onClick={() => save.mutate(value)} loading={save.isPending}>
              <Save className="h-4 w-4" /> {t('common.save')}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function SubtitlePreferencesSection() {
  const { canView, canManage, stored, isLoading, save } = useSettingField(
    'media.subtitles.preferredLanguages',
  );
  const [value, setValue] = useState('en');
  const { t } = useTranslation('media');
  useEffect(() => {
    if (stored) setValue(stored);
  }, [stored]);

  return (
    <SectionCard
      icon={<Subtitles className="h-5 w-5" />}
      title={t('settings.subtitlePref.title')}
      description={t('settings.subtitlePref.description')}
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">{t('settings.requiresSettings')}</p>
      ) : isLoading ? (
        <CenteredSpinner label={t('settings.metadata.loading')} />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Label htmlFor="sub-pref">{t('settings.subtitlePref.label')}</Label>
            <Input
              id="sub-pref"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('settings.subtitlePref.placeholder')}
              disabled={!canManage}
            />
          </div>
          {canManage && (
            <Button onClick={() => save.mutate(value.trim())} loading={save.isPending}>
              <Save className="h-4 w-4" /> {t('common.save')}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function RenameTemplatesSection() {
  const navigate = useNavigate();
  const { t } = useTranslation('media');
  return (
    <SectionCard
      icon={<Wand2 className="h-5 w-5" />}
      title={t('settings.renameTemplates.title')}
      description={t('settings.renameTemplates.description')}
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => navigate('/media/libraries')}>
          {t('settings.renameTemplates.libraryBtn')}
        </Button>
        <Button variant="outline" onClick={() => navigate('/media/rename')}>
          {t('settings.renameTemplates.engineBtn')}
        </Button>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Cleanup rules (junk deletion during rename/move)
// ---------------------------------------------------------------------------

function CleanupRulesSection() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_LIBRARIES);

  const { data, isLoading } = useQuery({
    queryKey: ['media', 'cleanup'],
    queryFn: api.media.getCleanup,
  });

  const [enabled, setEnabled] = useState(false);
  const [globs, setGlobs] = useState('');
  const [langs, setLangs] = useState('');
  const [prune, setPrune] = useState(false);
  const [removeTorrent, setRemoveTorrent] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setGlobs(data.deleteGlobs.join('\n'));
    setLangs(data.subtitleKeepLanguages.join(', '));
    setPrune(data.pruneEmptyDirs);
    setRemoveTorrent(data.removeLeftoverTorrent);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.media.updateCleanup({
        enabled,
        deleteGlobs: globs.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        subtitleKeepLanguages: langs.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
        pruneEmptyDirs: prune,
        removeLeftoverTorrent: removeTorrent,
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['media', 'cleanup'] });
    },
    onError: (err) => toast.error(t('common.couldNotSave'), err instanceof ApiError ? err.message : undefined),
  });

  return (
    <SectionCard
      icon={<Trash2 className="h-5 w-5" />}
      title={t('settings.cleanup.title')}
      description={t('settings.cleanup.description')}
    >
      {isLoading ? (
        <CenteredSpinner label={t('settings.metadata.loading')} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <div>
              <Label htmlFor="cleanup-enabled">{t('settings.cleanup.enabledLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('settings.cleanup.enabledHint')}</p>
            </div>
            <Switch id="cleanup-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={!canManage} />
          </div>

          <div>
            <Label htmlFor="cleanup-globs">{t('settings.cleanup.globsLabel')}</Label>
            <textarea
              id="cleanup-globs"
              className="mt-1 min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value={globs}
              onChange={(e) => setGlobs(e.target.value)}
              placeholder={t('settings.cleanup.globsPlaceholder')}
              disabled={!canManage}
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.cleanup.globsHint')}</p>
          </div>

          <div>
            <Label htmlFor="cleanup-langs">{t('settings.cleanup.langsLabel')}</Label>
            <Input
              id="cleanup-langs"
              value={langs}
              onChange={(e) => setLangs(e.target.value)}
              placeholder={t('settings.cleanup.langsPlaceholder')}
              disabled={!canManage}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.cleanup.langsHint')}</p>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="cleanup-prune">{t('settings.cleanup.pruneLabel')}</Label>
            <Switch id="cleanup-prune" checked={prune} onCheckedChange={setPrune} disabled={!canManage} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="cleanup-torrent">{t('settings.cleanup.removeTorrentLabel')}</Label>
            <Switch id="cleanup-torrent" checked={removeTorrent} onCheckedChange={setRemoveTorrent} disabled={!canManage} />
          </div>

          {canManage && (
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="h-4 w-4" /> {t('common.save')}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Media Server Integrations
// ---------------------------------------------------------------------------

function IntegrationsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MediaServerIntegration | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'server-integrations'],
    queryFn: api.media.listServerIntegrations,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['media', 'server-integrations'] });

  const remove = useMutation({
    mutationFn: (id: string) => api.media.deleteServerIntegration(id),
    onSuccess: () => {
      toast.success(t('settings.integrations.removedTitle'));
      invalidate();
    },
    onError: (err) => toast.error(t('settings.integrations.removeError'), err instanceof ApiError ? err.message : undefined),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.media.testServerIntegration(id),
    onSuccess: (res) => {
      if (res.ok) toast.success(t('settings.integrations.connOkTitle'), res.message);
      else toast.error(t('settings.integrations.connFailedTitle'), res.message);
    },
    onError: (err) => toast.error(t('settings.integrations.testFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => api.media.refreshServerIntegration(id),
    onSuccess: () => {
      toast.success(t('settings.integrations.refreshRequested'));
      invalidate();
    },
    onError: (err) => toast.error(t('settings.integrations.refreshFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const rows = data ?? [];

  return (
    <SectionCard
      icon={<Plug className="h-5 w-5" />}
      title={t('settings.integrations.title')}
      description={t('settings.integrations.description')}
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> {t('settings.integrations.addBtn')}
        </Button>
      }
    >
      {isLoading ? (
        <CenteredSpinner label={t('settings.integrations.loading')} />
      ) : isError ? (
        <ErrorState message={t('settings.integrations.error')} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-6 w-6" />}
          title={t('settings.integrations.emptyTitle')}
          description={t('settings.integrations.emptyBody')}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const busy =
              (test.isPending && test.variables === row.id) ||
              (refresh.isPending && refresh.variables === row.id) ||
              (remove.isPending && remove.variables === row.id);
            return (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{row.name}</p>
                    <Badge variant="secondary">{mediaServerKindLabel(t, row.kind)}</Badge>
                    <Badge variant={row.isEnabled ? 'success' : 'secondary'} dot>
                      {row.isEnabled ? t('common.enabled') : t('common.disabled')}
                    </Badge>
                  </div>
                  {row.lastRefreshAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('settings.integrations.lastRefresh', { time: formatRelativeTime(row.lastRefreshAt) })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => test.mutate(row.id)}
                    loading={test.isPending && test.variables === row.id}
                    disabled={busy}
                  >
                    {t('settings.integrations.test')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refresh.mutate(row.id)}
                    loading={refresh.isPending && refresh.variables === row.id}
                    disabled={busy || !row.isEnabled}
                  >
                    <RefreshCw className="h-4 w-4" /> {t('settings.integrations.refresh')}
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={t('settings.integrations.editAria')} onClick={() => setEditing(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('settings.integrations.deleteAria')}
                    onClick={() => {
                      if (confirm(t('settings.integrations.removeConfirm', { name: row.name }))) remove.mutate(row.id);
                    }}
                    disabled={busy}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <IntegrationDialog
          integration={editing}
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
    </SectionCard>
  );
}

function IntegrationDialog({
  integration,
  onClose,
  onSaved,
}: {
  integration: MediaServerIntegration | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation('media');
  const cfg = (integration?.config ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(integration?.name ?? '');
  const [kind, setKind] = useState(integration?.kind ?? 'plex');
  const [enabled, setEnabled] = useState(integration?.isEnabled ?? true);
  const [host, setHost] = useState(String(cfg.baseUrl ?? cfg.url ?? cfg.host ?? ''));
  const [token, setToken] = useState('');

  const isPlex = kind === 'plex';
  const tokenLabel = isPlex
    ? t('settings.integrations.tokenLabel.token')
    : t('settings.integrations.tokenLabel.apiKey');
  const tokenLower = isPlex
    ? t('settings.integrations.tokenLabelLower.token')
    : t('settings.integrations.tokenLabelLower.apiKey');

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { baseUrl: host.trim() };
      // Only send a secret when the user typed one (avoids clobbering on edit).
      if (token.trim()) config[isPlex ? 'token' : 'apiKey'] = token.trim();
      const body: MediaServerIntegrationInput = {
        name: name.trim(),
        kind,
        isEnabled: enabled,
        config,
      };
      return integration
        ? api.media.updateServerIntegration(integration.id, body)
        : api.media.createServerIntegration(body);
    },
    onSuccess: () => {
      toast.success(
        integration ? t('settings.integrations.updatedTitle') : t('settings.integrations.addedTitle'),
        name.trim(),
      );
      onSaved();
    },
    onError: (err) => toast.error(t('settings.integrations.saveError'), err instanceof ApiError ? err.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{integration ? t('settings.integrations.dialog.editTitle') : t('settings.integrations.dialog.addTitle')}</DialogTitle>
        <DialogDescription>
          {t('settings.integrations.dialog.description', { token: tokenLower })}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="int-name">{t('settings.integrations.field.name')}</Label>
          <Input id="int-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.integrations.field.namePlaceholder')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="int-kind">{t('settings.integrations.field.kind')}</Label>
            <Select
              id="int-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={mediaServerKindOptions(t)}
            />
          </div>
          <div>
            <Label htmlFor="int-host">{t('settings.integrations.field.host')}</Label>
            <Input
              id="int-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('settings.integrations.field.hostPlaceholder')}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="int-token">{tokenLabel}</Label>
          <Input
            id="int-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={integration ? t('settings.integrations.field.tokenPlaceholderKeep') : t('settings.integrations.field.tokenPlaceholderNew', { token: tokenLower })}
            autoComplete="off"
          />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="int-enabled">{t('settings.integrations.field.enabled')}</Label>
          <Switch id="int-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
          {integration ? t('common.saveChanges') : t('settings.integrations.addBtn')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
