import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Wand2,
} from 'lucide-react';
import {
  ApiError,
  api,
  type MediaServerIntegration,
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
import { MEDIA_SERVER_KIND_OPTIONS, mediaServerKindLabel } from './constants';

export function MediaSettingsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManageIntegrations = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_INTEGRATIONS);
  const canViewImdb = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          Media Manager
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Media Settings</h1>
        <p className="text-sm text-muted-foreground">
          Metadata providers, artwork and subtitle preferences, rename templates, and media-server
          integrations.
        </p>
      </div>

      <MetadataProvidersSection />
      {canViewImdb && (
        <SectionCard
          icon={<Film className="h-5 w-5" />}
          title="IMDb provider"
          description="Configure IMDb metadata from user-provided datasets or a licensed IMDb API."
          actions={
            <Button size="sm" variant="outline" onClick={() => navigate('/media/settings/imdb')}>
              Configure IMDb
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Dataset import, official-API configuration, and matching preferences for the IMDb
            provider.
          </p>
        </SectionCard>
      )}
      <ArtworkPreferencesSection />
      <SubtitlePreferencesSection />
      <RenameTemplatesSection />
      {canManageIntegrations ? (
        <IntegrationsSection />
      ) : (
        <SectionCard icon={<Plug className="h-5 w-5" />} title="Media Server Integrations">
          <p className="text-sm text-muted-foreground">
            You do not have permission to manage media-server integrations.
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

  const query = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    enabled: canView,
  });

  const save = useMutation({
    mutationFn: (value: string) => api.settings.update({ [key]: value }),
    onSuccess: () => {
      toast.success('Saved');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  });

  const stored = canView ? ((query.data?.[key] as string | undefined) ?? '') : '';
  return { canView, canManage, stored, isLoading: query.isLoading, save };
}

function MetadataProvidersSection() {
  const { canView, canManage, stored, isLoading, save } = useSettingField('media.tmdbApiKey');
  const [value, setValue] = useState('');
  useEffect(() => setValue(stored), [stored]);

  return (
    <SectionCard
      icon={<KeyRound className="h-5 w-5" />}
      title="Metadata providers"
      description="TMDB powers rich metadata and artwork. Without a key, local NFO metadata is used."
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">
          You do not have permission to view settings. Ask an administrator to configure the TMDB API
          key.
        </p>
      ) : isLoading ? (
        <CenteredSpinner label="Loading…" />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Label htmlFor="tmdb-key">TMDB API key</Label>
            <Input
              id="tmdb-key"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter TMDB API key"
              disabled={!canManage}
              autoComplete="off"
            />
          </div>
          {canManage && (
            <Button onClick={() => save.mutate(value.trim())} loading={save.isPending}>
              <Save className="h-4 w-4" /> Save
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function ArtworkPreferencesSection() {
  const { canView, canManage, stored, isLoading, save } = useSettingField('media.artwork.preferredType');
  const [value, setValue] = useState('poster');
  useEffect(() => {
    if (stored) setValue(stored);
  }, [stored]);

  return (
    <SectionCard
      icon={<ImageIcon className="h-5 w-5" />}
      title="Artwork preferences"
      description="Which artwork type to prefer when multiple are available."
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">Requires settings access.</p>
      ) : isLoading ? (
        <CenteredSpinner label="Loading…" />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <Label htmlFor="art-pref">Preferred artwork type</Label>
            <Select
              id="art-pref"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={!canManage}
              options={[
                { value: 'poster', label: 'Poster' },
                { value: 'fanart', label: 'Fanart' },
                { value: 'banner', label: 'Banner' },
                { value: 'thumbnail', label: 'Thumbnail' },
              ]}
            />
          </div>
          {canManage && (
            <Button onClick={() => save.mutate(value)} loading={save.isPending}>
              <Save className="h-4 w-4" /> Save
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
  useEffect(() => {
    if (stored) setValue(stored);
  }, [stored]);

  return (
    <SectionCard
      icon={<Subtitles className="h-5 w-5" />}
      title="Subtitle preferences"
      description="Preferred subtitle languages (comma-separated ISO codes), used to flag missing subtitles."
    >
      {!canView ? (
        <p className="text-sm text-muted-foreground">Requires settings access.</p>
      ) : isLoading ? (
        <CenteredSpinner label="Loading…" />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Label htmlFor="sub-pref">Preferred languages</Label>
            <Input
              id="sub-pref"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="en, es, fr"
              disabled={!canManage}
            />
          </div>
          {canManage && (
            <Button onClick={() => save.mutate(value.trim())} loading={save.isPending}>
              <Save className="h-4 w-4" /> Save
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function RenameTemplatesSection() {
  const navigate = useNavigate();
  return (
    <SectionCard
      icon={<Wand2 className="h-5 w-5" />}
      title="Rename templates"
      description="Naming templates are configured per library and in the rename engine."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => navigate('/media/libraries')}>
          Library templates
        </Button>
        <Button variant="outline" onClick={() => navigate('/media/rename')}>
          Rename engine templates
        </Button>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Media Server Integrations
// ---------------------------------------------------------------------------

function IntegrationsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
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
      toast.success('Integration removed');
      invalidate();
    },
    onError: (err) => toast.error('Could not remove', err instanceof ApiError ? err.message : undefined),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.media.testServerIntegration(id),
    onSuccess: (res) => {
      if (res.ok) toast.success('Connection OK', res.message);
      else toast.error('Connection failed', res.message);
    },
    onError: (err) => toast.error('Test failed', err instanceof ApiError ? err.message : undefined),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => api.media.refreshServerIntegration(id),
    onSuccess: () => {
      toast.success('Library refresh requested');
      invalidate();
    },
    onError: (err) => toast.error('Refresh failed', err instanceof ApiError ? err.message : undefined),
  });

  const rows = data ?? [];

  return (
    <SectionCard
      icon={<Plug className="h-5 w-5" />}
      title="Media Server Integrations"
      description="Connect Plex, Jellyfin, Emby, or Kodi to trigger library refreshes."
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Add integration
        </Button>
      }
    >
      {isLoading ? (
        <CenteredSpinner label="Loading integrations…" />
      ) : isError ? (
        <ErrorState message="Could not load integrations." onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-6 w-6" />}
          title="No integrations"
          description="Add a media-server integration to keep your server’s library in sync."
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
                    <Badge variant="secondary">{mediaServerKindLabel(row.kind)}</Badge>
                    <Badge variant={row.isEnabled ? 'success' : 'secondary'} dot>
                      {row.isEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  {row.lastRefreshAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last refresh {formatRelativeTime(row.lastRefreshAt)}
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
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refresh.mutate(row.id)}
                    loading={refresh.isPending && refresh.variables === row.id}
                    disabled={busy || !row.isEnabled}
                  >
                    <RefreshCw className="h-4 w-4" /> Refresh
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Delete"
                    onClick={() => {
                      if (confirm(`Remove integration "${row.name}"?`)) remove.mutate(row.id);
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
  const cfg = (integration?.config ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(integration?.name ?? '');
  const [kind, setKind] = useState(integration?.kind ?? 'plex');
  const [enabled, setEnabled] = useState(integration?.isEnabled ?? true);
  const [host, setHost] = useState(String(cfg.url ?? cfg.host ?? ''));
  const [token, setToken] = useState('');

  const isPlex = kind === 'plex';
  const tokenLabel = isPlex ? 'Token' : 'API key';

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { url: host.trim() };
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
      toast.success(integration ? 'Integration updated' : 'Integration added', name.trim());
      onSaved();
    },
    onError: (err) => toast.error('Could not save integration', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{integration ? 'Edit integration' : 'Add integration'}</DialogTitle>
        <DialogDescription>
          Secrets are encrypted at rest and never shown again. Leave the {tokenLabel.toLowerCase()}{' '}
          blank to keep the existing one.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="int-name">Name</Label>
          <Input id="int-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Living Room Plex" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="int-kind">Kind</Label>
            <Select
              id="int-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={MEDIA_SERVER_KIND_OPTIONS}
            />
          </div>
          <div>
            <Label htmlFor="int-host">Host / URL</Label>
            <Input
              id="int-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="http://localhost:32400"
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
            placeholder={integration ? 'Leave blank to keep existing' : `Enter ${tokenLabel.toLowerCase()}`}
            autoComplete="off"
          />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="int-enabled">Enabled</Label>
          <Switch id="int-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
          {integration ? 'Save changes' : 'Add integration'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
