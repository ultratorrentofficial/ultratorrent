import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleX,
  Cpu,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ApiError,
  api,
  type CreateEngineInput,
  type EngineConnectionInput,
  type EngineMode,
  type EngineSummary,
  type UpdateEngineInput,
} from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
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
import { CenteredSpinner, EmptyState, ErrorState, Spinner } from '@/components/ui/feedback';

const KIND_OPTIONS: { value: string; disabled?: boolean }[] = [
  { value: 'rtorrent' },
  { value: 'qbittorrent', disabled: true },
  { value: 'transmission', disabled: true },
  { value: 'deluge', disabled: true },
];

export function EnginesPage() {
  const { t } = useTranslation('engines');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.ENGINES_MANAGE);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EngineSummary | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['engines'],
    queryFn: api.engines.list,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['engines'] });
    queryClient.invalidateQueries({ queryKey: ['engine-health'] });
    // Torrents/stats depend on the resolved default engine.
    queryClient.invalidateQueries({ queryKey: ['torrents'] });
  };

  const remove = async (engine: EngineSummary) => {
    if (!confirm(t('confirm.delete', { name: engine.name }))) return;
    try {
      await api.engines.remove(engine.id);
      toast.success(t('toast.removed'), engine.name);
      invalidate();
    } catch (err) {
      toast.error(t('toast.removeFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const makeDefault = async (engine: EngineSummary) => {
    try {
      await api.engines.update(engine.id, { isDefault: true });
      toast.success(t('toast.defaultUpdated'), engine.name);
      invalidate();
    } catch (err) {
      toast.error(t('toast.defaultFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('actions.addEngine')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <CenteredSpinner label={t('list.loading')} />
      ) : isError ? (
        <ErrorState message={t('list.error')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Cpu className="h-6 w-6" />}
              title={t('empty.title')}
              description={t('empty.description')}
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" /> {t('empty.action')}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((engine) => (
            <Card key={engine.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{engine.name}</p>
                    <Badge variant="info">{engine.kind}</Badge>
                    {engine.isDefault && (
                      <Badge variant="success" dot>
                        {t('badge.default')}
                      </Badge>
                    )}
                    {!engine.isEnabled && <Badge variant="secondary">{t('badge.disabled')}</Badge>}
                    <HealthBadge engineId={engine.id} enabled={engine.isEnabled} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{engine.mode}</span>
                    {engine.mode === 'scgi-unix' ? (
                      <span className="font-mono">{engine.socketPath}</span>
                    ) : engine.mode === 'http' ? (
                      <span className="font-mono">{engine.url}</span>
                    ) : (
                      <span className="font-mono">
                        {engine.host}:{engine.port}
                      </span>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    {!engine.isDefault && engine.isEnabled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('actions.setDefault')}
                        title={t('actions.setDefault')}
                        onClick={() => makeDefault(engine)}
                      >
                        <Star className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('actions.editEngine')}
                      onClick={() => setEditing(engine)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('actions.deleteEngine')}
                      onClick={() => remove(engine)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <EngineDialog
          engine={editing}
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
    </div>
  );
}

function HealthBadge({ engineId, enabled }: { engineId: string; enabled: boolean }) {
  const { t } = useTranslation('engines');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['engine-health', engineId],
    queryFn: () => api.engines.health(engineId),
    enabled,
    refetchInterval: 20000,
    retry: false,
  });

  if (!enabled) return null;
  if (isLoading) return <Spinner className="h-3.5 w-3.5" />;
  if (isError || !data?.online) {
    return (
      <Badge variant="destructive" dot>
        <CircleX className="h-3 w-3" /> {t('health.offline')}
      </Badge>
    );
  }
  return (
    <Badge variant="success" dot>
      <CircleCheck className="h-3 w-3" /> {t('health.online')}
      {data.latencyMs != null && (
        <span className="text-muted-foreground">· {data.latencyMs}ms</span>
      )}
    </Badge>
  );
}

const DEFAULTS: EngineConnectionInput = {
  mode: 'scgi-tcp',
  host: 'rtorrent',
  port: 5000,
  timeoutMs: 10000,
};

function EngineDialog({
  engine,
  onClose,
  onSaved,
}: {
  engine: EngineSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('engines');
  const toast = useToast();
  const isEdit = !!engine;
  const kindLabels: Record<string, string> = {
    rtorrent: t('kinds.rtorrent'),
    qbittorrent: t('kinds.qbittorrent'),
    transmission: t('kinds.transmission'),
    deluge: t('kinds.deluge'),
  };
  const modeOptions: { value: EngineMode; label: string }[] = [
    { value: 'scgi-tcp', label: t('modes.scgiTcp') },
    { value: 'scgi-unix', label: t('modes.scgiUnix') },
    { value: 'http', label: t('modes.http') },
  ];
  const [name, setName] = useState(engine?.name ?? '');
  const [kind, setKind] = useState(engine?.kind ?? 'rtorrent');
  const [mode, setMode] = useState<EngineMode>(engine?.mode ?? DEFAULTS.mode);
  const [host, setHost] = useState(engine?.host ?? DEFAULTS.host ?? '');
  const [port, setPort] = useState(String(engine?.port ?? DEFAULTS.port ?? ''));
  const [socketPath, setSocketPath] = useState(engine?.socketPath ?? '');
  const [url, setUrl] = useState(engine?.url ?? '');
  const [timeoutMs, setTimeoutMs] = useState(String(engine?.timeoutMs ?? DEFAULTS.timeoutMs ?? ''));
  const [isDefault, setIsDefault] = useState(engine?.isDefault ?? false);
  const [isEnabled, setIsEnabled] = useState(engine?.isEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const buildConfig = (): EngineConnectionInput => {
    const cfg: EngineConnectionInput = { mode };
    if (mode === 'scgi-unix') {
      cfg.socketPath = socketPath.trim();
    } else if (mode === 'http') {
      cfg.url = url.trim();
    } else {
      cfg.host = host.trim();
      cfg.port = Number(port);
    }
    if (timeoutMs.trim()) cfg.timeoutMs = Number(timeoutMs);
    return cfg;
  };

  const connectionValid =
    mode === 'scgi-unix'
      ? socketPath.trim().length > 0
      : mode === 'http'
        ? url.trim().length > 0
        : host.trim().length > 0 && Number(port) > 0;
  const valid = name.trim().length > 0 && connectionValid;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.engines.test({ kind, config: buildConfig() });
      setTestResult(
        res.online
          ? {
              ok: true,
              text: `${t('dialog.testConnected')}${res.version ? ` — ${res.version}` : ''}${
                res.latencyMs != null ? ` (${res.latencyMs}ms)` : ''
              }`,
            }
          : { ok: false, text: res.error ?? t('dialog.testNoResponse') },
      );
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof ApiError ? err.message : t('dialog.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      if (isEdit && engine) {
        const body: UpdateEngineInput = {
          name: name.trim(),
          config: buildConfig(),
          isDefault,
          isEnabled,
        };
        await api.engines.update(engine.id, body);
        toast.success(t('toast.updated'), name.trim());
      } else {
        const body: CreateEngineInput = {
          name: name.trim(),
          kind,
          config: buildConfig(),
          isDefault,
          isEnabled,
        };
        await api.engines.create(body);
        toast.success(t('toast.added'), name.trim());
      }
      onSaved();
    } catch (err) {
      toast.error(
        isEdit ? t('toast.updateFailed') : t('toast.addFailed'),
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t('dialog.editTitle', { name: engine?.name }) : t('dialog.addTitle')}
        </DialogTitle>
        <DialogDescription>
          <Trans t={t} i18nKey="dialog.description" components={{ code: <code /> }} />
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="e-name">{t('dialog.name')}</Label>
            <Input
              id="e-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('dialog.namePlaceholder')}
            />
          </div>
          <div>
            <Label htmlFor="e-kind">{t('dialog.client')}</Label>
            <Select
              id="e-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={isEdit}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {kindLabels[o.value]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="e-mode">{t('dialog.connection')}</Label>
          <Select
            id="e-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as EngineMode)}
            options={modeOptions}
          />
        </div>

        {mode === 'scgi-unix' ? (
          <div>
            <Label htmlFor="e-socket">{t('dialog.socketPath')}</Label>
            <Input
              id="e-socket"
              value={socketPath}
              onChange={(e) => setSocketPath(e.target.value)}
              placeholder="/var/run/rtorrent/rpc.socket"
              className="font-mono"
            />
          </div>
        ) : mode === 'http' ? (
          <div>
            <Label htmlFor="e-url">{t('dialog.url')}</Label>
            <Input
              id="e-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://rtorrent:8080/RPC2"
              className="font-mono"
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-host">{t('dialog.host')}</Label>
              <Input
                id="e-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="rtorrent"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="e-port">{t('dialog.port')}</Label>
              <Input
                id="e-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="5000"
              />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="e-timeout">{t('dialog.timeout')}</Label>
          <Input
            id="e-timeout"
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            placeholder="10000"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="e-default">{t('dialog.defaultEngine')}</Label>
            <Switch id="e-default" checked={isDefault} onCheckedChange={setIsDefault} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <Label htmlFor="e-enabled">{t('dialog.enabled')}</Label>
            <Switch id="e-enabled" checked={isEnabled} onCheckedChange={setIsEnabled} />
          </div>
        </div>

        {testResult && (
          <div
            className={
              testResult.ok
                ? 'flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400'
                : 'flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive'
            }
          >
            {testResult.ok ? (
              <CircleCheck className="h-4 w-4 shrink-0" />
            ) : (
              <CircleX className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 break-words">{testResult.text}</span>
          </div>
        )}
      </div>
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" onClick={runTest} loading={testing} disabled={!connectionValid}>
          {t('dialog.testConnection')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={submit} loading={saving} disabled={!valid}>
            {isEdit ? t('dialog.saveChanges') : t('dialog.addTitle')}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
