import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, ApiError, type MediaServerConnectionSummary, type MediaServerInfo } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/**
 * Add or edit a media server connection.
 *
 * Every kind needs a different credential, and offering all of them at once
 * invites putting a Plex token in the API-key box: the field swaps with the
 * selector instead.
 *
 * Test runs against the FORM, not a saved row (`connections/test-config`), so a
 * wrong URL or key is caught before anything is written. Testing only saved
 * connections would force an operator to persist the mistake first and then
 * clean it up.
 */

export type ConnectionKind = 'plex' | 'jellyfin' | 'emby' | 'kodi';

const KINDS: ConnectionKind[] = ['plex', 'jellyfin', 'emby', 'kodi'];

/** Which secret each server actually authenticates with. */
const CREDENTIAL: Record<ConnectionKind, 'token' | 'apiKey' | 'userPass'> = {
  plex: 'token',
  jellyfin: 'apiKey',
  emby: 'apiKey',
  kodi: 'userPass',
};

interface Props {
  /** Editing an existing row, or null to create a new one. */
  existing: MediaServerConnectionSummary | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ConnectionFormDialog({ existing, onClose, onSaved }: Props) {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ConnectionKind>('jellyfin');
  const [enabled, setEnabled] = useState(true);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [probe, setProbe] = useState<MediaServerInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setKind(existing.kind as ConnectionKind);
    setEnabled(existing.enabled);
    // Secrets come back masked and are never echoed into the form: an empty
    // credential on edit means "keep what is stored".
    const cfg = (existing as unknown as { config?: Record<string, string> }).config ?? {};
    setBaseUrl(cfg.baseUrl ?? '');
  }, [existing]);

  /** Only the fields this kind uses, and only secrets actually typed. */
  const buildConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = { baseUrl: baseUrl.trim() };
    const which = CREDENTIAL[kind];
    if (which === 'token' && token.trim()) cfg.token = token.trim();
    if (which === 'apiKey' && apiKey.trim()) cfg.apiKey = apiKey.trim();
    if (which === 'userPass') {
      if (username.trim()) cfg.username = username.trim();
      if (password) cfg.password = password;
    }
    return cfg;
  };

  const testIt = useMutation({
    mutationFn: () => api.mediaServerAnalytics.testConnectionConfig({ kind, config: buildConfig() }),
    onMutate: () => { setProbe(null); setProbeError(null); },
    onSuccess: (info) => setProbe(info),
    onError: (e) => setProbeError(e instanceof ApiError ? e.message : String(e)),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), kind, isEnabled: enabled, config: buildConfig() };
      return existing
        ? api.mediaServerAnalytics.updateConnection(existing.id, body)
        : api.mediaServerAnalytics.createConnection(body);
    },
    onSuccess: () => {
      toast.success(existing ? t('connections.form.updated') : t('connections.form.created'));
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(t('connections.form.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const credential = CREDENTIAL[kind];
  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && !save.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-xl">
        <h2 className="text-lg font-semibold">
          {existing ? t('connections.form.editTitle') : t('connections.form.addTitle')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('connections.form.subtitle')}</p>

        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="conn-name">{t('connections.form.name')}</Label>
            <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="LIVINGROOM-JELLYFIN" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="conn-kind">{t('connections.form.kind')}</Label>
            <select
              id="conn-kind"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(e) => { setKind(e.target.value as ConnectionKind); setProbe(null); setProbeError(null); }}
            >
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="conn-url">{t('connections.form.baseUrl')}</Label>
            <Input id="conn-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://10.0.0.5:8096" />
            <p className="text-xs text-muted-foreground">{t('connections.form.baseUrlHint')}</p>
          </div>

          {credential === 'token' && (
            <div className="space-y-1">
              <Label htmlFor="conn-token">{t('connections.form.plexToken')}</Label>
              <Input id="conn-token" type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder={existing ? t('connections.form.keepStored') : ''} />
              <p className="text-xs text-muted-foreground">{t('connections.form.plexTokenHint')}</p>
            </div>
          )}

          {credential === 'apiKey' && (
            <div className="space-y-1">
              <Label htmlFor="conn-key">{t('connections.form.apiKey')}</Label>
              <Input id="conn-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={existing ? t('connections.form.keepStored') : ''} />
              <p className="text-xs text-muted-foreground">{t('connections.form.apiKeyHint')}</p>
            </div>
          )}

          {credential === 'userPass' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="conn-user">{t('connections.form.username')}</Label>
                <Input id="conn-user" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="conn-pass">{t('connections.form.password')}</Label>
                <Input id="conn-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder={existing ? t('connections.form.keepStored') : ''} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Switch id="conn-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="conn-enabled">{t('connections.form.enabled')}</Label>
          </div>

          {/* The result of testing the form, before anything is written. */}
          {probe && (
            <div className={`flex items-start gap-2 rounded-md border p-2 text-sm ${probe.reachable ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10'}`}>
              {probe.reachable
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />}
              <span>
                {probe.message}
                {probe.version ? <span className="ml-2 text-xs text-muted-foreground">v{probe.version}</span> : null}
              </span>
            </div>
          )}
          {probeError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <span>{probeError}</span>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-between gap-2">
          <Button variant="secondary" onClick={() => testIt.mutate()} disabled={!baseUrl.trim() || testIt.isPending}>
            {testIt.isPending ? t('connections.form.testing') : t('connections.form.test')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t('connections.form.cancel')}</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave}>{t('connections.form.save')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
