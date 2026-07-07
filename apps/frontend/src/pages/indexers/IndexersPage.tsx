import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Pencil, Plus, Radar, TestTube, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ApiError,
  api,
  type CreateIndexerInput,
  type Indexer,
  type UpdateIndexerInput,
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
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const REDACTED = '••••••••';

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('indexers');
  if (status === 'ok') {
    return (
      <Badge variant="success" dot>
        <CircleCheck className="h-3 w-3" /> {t('status.ok')}
      </Badge>
    );
  }
  if (status === 'error') {
    return (
      <Badge variant="destructive" dot>
        <CircleX className="h-3 w-3" /> {t('status.error')}
      </Badge>
    );
  }
  return <Badge variant="secondary">{t('status.unknown')}</Badge>;
}

export function IndexersPage() {
  const { t } = useTranslation('indexers');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.INDEXERS_MANAGE);
  const canTest = hasPermission(PERMISSIONS.INDEXERS_TEST);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Indexer | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['indexers'],
    queryFn: api.indexers.list,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['indexers'] });

  const remove = async (indexer: Indexer) => {
    if (!confirm(t('confirm.delete', { name: indexer.name }))) return;
    try {
      await api.indexers.remove(indexer.id);
      toast.success(t('toast.removed'), indexer.name);
      invalidate();
    } catch (err) {
      toast.error(t('toast.removeFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const runTest = async (indexer: Indexer) => {
    setTestingId(indexer.id);
    try {
      const res = await api.indexers.test(indexer.id);
      if (res.error) {
        toast.error(t('toast.testFailed'), res.error);
      } else {
        toast.success(t('toast.testOk'), t('toast.testCaps', { count: res.capabilities?.categories.length ?? 0 }));
      }
      invalidate();
    } catch (err) {
      toast.error(t('toast.testFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setTestingId(null);
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
            <Plus className="h-4 w-4" /> {t('actions.add')}
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
              icon={<Radar className="h-6 w-6" />}
              title={t('empty.title')}
              description={t('empty.description')}
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" /> {t('actions.add')}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((indexer) => (
            <Card key={indexer.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{indexer.name}</p>
                    <Badge variant="info">{indexer.implementation}</Badge>
                    {!indexer.enabled && <Badge variant="secondary">{t('badge.disabled')}</Badge>}
                    <StatusBadge status={indexer.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">{indexer.baseUrl}</span>
                    <span>{t('field.priority')}: {indexer.priority}</span>
                    {indexer.categories.length > 0 && (
                      <span>{t('field.categories')}: {indexer.categories.join(', ')}</span>
                    )}
                    {indexer.statusMessage && (
                      <span className="text-destructive">{indexer.statusMessage}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canTest && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('actions.test')}
                      title={t('actions.test')}
                      loading={testingId === indexer.id}
                      onClick={() => runTest(indexer)}
                    >
                      <TestTube className="h-4 w-4" />
                    </Button>
                  )}
                  {canManage && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('actions.edit')}
                        onClick={() => setEditing(indexer)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('actions.delete')}
                        onClick={() => remove(indexer)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <IndexerDialog
          indexer={editing}
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

function IndexerDialog({
  indexer,
  onClose,
  onSaved,
}: {
  indexer: Indexer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('indexers');
  const toast = useToast();
  const isEdit = !!indexer;
  const [name, setName] = useState(indexer?.name ?? '');
  const [implementation, setImplementation] = useState(indexer?.implementation ?? 'torznab');
  const [baseUrl, setBaseUrl] = useState(indexer?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(indexer?.apiKey ?? '');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [categories, setCategories] = useState((indexer?.categories ?? [5000, 5030, 5040]).join(', '));
  const [priority, setPriority] = useState(String(indexer?.priority ?? 25));
  const [minSeeders, setMinSeeders] = useState(indexer?.minSeeders != null ? String(indexer.minSeeders) : '');
  const [timeoutMs, setTimeoutMs] = useState(String(indexer?.timeoutMs ?? 15000));
  const [enabled, setEnabled] = useState(indexer?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && baseUrl.trim().length > 0;

  const parsedCategories = categories
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const submit = async () => {
    setSaving(true);
    try {
      const common = {
        name: name.trim(),
        implementation,
        baseUrl: baseUrl.trim(),
        categories: parsedCategories,
        priority: Number(priority) || 0,
        minSeeders: minSeeders.trim() ? Number(minSeeders) : null,
        timeoutMs: Number(timeoutMs) || 15000,
        enabled,
      };
      if (isEdit && indexer) {
        const body: UpdateIndexerInput = { ...common };
        if (apiKeyDirty) body.apiKey = apiKey.trim();
        await api.indexers.update(indexer.id, body);
        toast.success(t('toast.updated'), name.trim());
      } else {
        const body: CreateIndexerInput = { ...common };
        if (apiKey.trim()) body.apiKey = apiKey.trim();
        await api.indexers.create(body);
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
        <DialogTitle>{isEdit ? t('dialog.editTitle', { name: indexer?.name }) : t('dialog.addTitle')}</DialogTitle>
        <DialogDescription>{t('dialog.description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ix-name">{t('field.name')}</Label>
            <Input id="ix-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('field.namePlaceholder')} />
          </div>
          <div>
            <Label htmlFor="ix-impl">{t('field.implementation')}</Label>
            <Select id="ix-impl" value={implementation} onChange={(e) => setImplementation(e.target.value)}>
              <option value="torznab">Torznab</option>
              <option value="newznab">Newznab</option>
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="ix-url">{t('field.baseUrl')}</Label>
          <Input
            id="ix-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://indexer.example/api"
            className="font-mono"
          />
        </div>

        <div>
          <Label htmlFor="ix-key">{t('field.apiKey')}</Label>
          <Input
            id="ix-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKeyDirty(true);
              setApiKey(e.target.value);
            }}
            onFocus={() => {
              if (!apiKeyDirty && apiKey === REDACTED) setApiKey('');
            }}
            placeholder={indexer?.apiKey ? t('field.apiKeyKeep') : t('field.apiKeyNew')}
            className="font-mono"
          />
        </div>

        <div>
          <Label htmlFor="ix-cats">{t('field.categories')}</Label>
          <Input id="ix-cats" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="5000, 5030, 5040" />
          <p className="mt-1 text-xs text-muted-foreground">{t('field.categoriesHint')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="ix-priority">{t('field.priority')}</Label>
            <Input id="ix-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ix-seeders">{t('field.minSeeders')}</Label>
            <Input id="ix-seeders" type="number" value={minSeeders} onChange={(e) => setMinSeeders(e.target.value)} placeholder="—" />
          </div>
          <div>
            <Label htmlFor="ix-timeout">{t('field.timeout')}</Label>
            <Input id="ix-timeout" type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="ix-enabled">{t('field.enabled')}</Label>
          <Switch id="ix-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button onClick={submit} loading={saving} disabled={!valid}>
          {isEdit ? t('dialog.save') : t('dialog.addTitle')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
