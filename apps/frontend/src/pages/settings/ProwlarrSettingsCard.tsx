import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError, type ProwlarrStatus } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge, type BadgeVariant } from '@/components/ui/badge';

const REDACTED = '••••••••';

const STATUS_VARIANT: Record<ProwlarrStatus, BadgeVariant> = {
  ok: 'success',
  error: 'destructive',
  disabled: 'secondary',
  unconfigured: 'warning',
  unknown: 'secondary',
};

/**
 * Settings → Integrations → Prowlarr. Links UltraTorrent to a **separate**
 * optional Prowlarr companion container (indexer manager). The API key is
 * write-only (masked, sent only when changed); the URL is never proxied — only
 * a read-only health check and an "Open Prowlarr" shortcut. Self-contained
 * (own `prowlarr` i18n namespace + API calls) so it drops into the Settings page.
 */
export function ProwlarrSettingsCard() {
  const { t } = useTranslation('prowlarr');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = hasPermission(PERMISSIONS.INTEGRATIONS_PROWLARR_MANAGE);
  const canTest = hasPermission(PERMISSIONS.INTEGRATIONS_PROWLARR_TEST);
  const canOpen = hasPermission(PERMISSIONS.INTEGRATIONS_PROWLARR_OPEN);

  const q = useQuery({ queryKey: ['prowlarr', 'settings'], queryFn: () => api.prowlarr.get() });

  const [enabled, setEnabled] = useState(false);
  const [internalUrl, setInternalUrl] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setEnabled(q.data.enabled);
    setInternalUrl(q.data.internalUrl);
    setPublicUrl(q.data.publicUrl);
    setApiKey(q.data.hasApiKey ? REDACTED : '');
    setApiKeyDirty(false);
  }, [q.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['prowlarr'] });

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { enabled, internalUrl, publicUrl };
      if (apiKeyDirty) body.apiKey = apiKey.trim(); // write-only: only send when changed
      return api.prowlarr.update(body);
    },
    onSuccess: () => {
      toast.success(t('toast.saved'));
      invalidate();
    },
    onError: (e) => toast.error(t('toast.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const test = useMutation({
    // Test the current form values (falls back to the stored key when unchanged).
    mutationFn: () => api.prowlarr.test(apiKeyDirty ? { internalUrl, apiKey: apiKey.trim() } : { internalUrl }),
    onSuccess: (r) => {
      if (r.ok) toast.success(t('toast.testOk', { version: r.version ?? '?' }));
      else toast.error(t('toast.testFailed'), r.message);
      invalidate();
    },
    onError: (e) => toast.error(t('toast.testFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const openProwlarr = useMutation({
    mutationFn: () => api.prowlarr.open(),
    onSuccess: (r) => window.open(r.url, '_blank', 'noopener,noreferrer'),
    onError: (e) => toast.error(t('toast.openFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const status = q.data?.status ?? 'unknown';

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4" /> {t('title')}
          </h2>
          <Badge variant={STATUS_VARIANT[status]} dot>
            {t(`status.${status}`)}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">{t('description')}</p>

        <div className="flex items-center gap-2">
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canManage} />
          <span className="text-sm">{t('fields.enabled')}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pl-internal">{t('fields.internalUrl')}</Label>
            <Input
              id="pl-internal"
              value={internalUrl}
              onChange={(e) => setInternalUrl(e.target.value)}
              placeholder="http://prowlarr:9696"
              disabled={!canManage}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">{t('fields.internalUrlHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-public">{t('fields.publicUrl')}</Label>
            <Input
              id="pl-public"
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="http://localhost:9696"
              disabled={!canManage}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">{t('fields.publicUrlHint')}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pl-key">{t('fields.apiKey')}</Label>
            <Input
              id="pl-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setApiKeyDirty(true);
              }}
              onFocus={() => {
                if (!apiKeyDirty && apiKey === REDACTED) {
                  setApiKey('');
                  setApiKeyDirty(true);
                }
              }}
              placeholder={q.data?.hasApiKey ? t('fields.apiKeyKeep') : t('fields.apiKeyNew')}
              disabled={!canManage}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">{t('fields.apiKeyHint')}</p>
          </div>
        </div>

        {q.data?.status === 'error' && q.data.statusMessage && (
          <p className="text-xs text-destructive">{q.data.statusMessage}</p>
        )}
        {q.data?.version && (
          <p className="text-[11px] text-muted-foreground">
            {t('info.version', { version: q.data.version })}
            {q.data.indexerCount != null && ` · ${t('info.indexers', { count: q.data.indexerCount })}`}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              {t('actions.save')}
            </Button>
          )}
          {canTest && (
            <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
              {t('actions.test')}
            </Button>
          )}
          {canOpen && (
            <Button
              variant="ghost"
              onClick={() => openProwlarr.mutate()}
              loading={openProwlarr.isPending}
              disabled={!q.data?.publicUrl}
            >
              <ExternalLink className="h-4 w-4" /> {t('actions.open')}
            </Button>
          )}
        </div>

        <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">
          <p className="mb-1 font-medium text-foreground/80">{t('help.title')}</p>
          <p>{t('help.body')}</p>
          <pre className="mt-1.5 overflow-x-auto rounded bg-background/60 p-2 font-mono text-[11px]">
            docker compose --profile prowlarr up -d
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
