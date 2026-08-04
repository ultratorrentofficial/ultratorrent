import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { ApiError, api, type SchedulerPolicy } from '@/lib/api';
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
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';

/**
 * Policies, edited by typed fields.
 *
 * Only the three concurrency limits appear, because they are the only ones
 * anything enforces today. Showing a bandwidth field now would let an operator
 * configure a limit that silently does nothing to their queue — the failure the
 * cleanup policy builder was rebuilt to avoid, in a different costume.
 *
 * An empty box means unlimited, and that is written as an explicit decision
 * rather than left absent, because a more specific policy has to be able to LIFT
 * a broader one's cap, not merely tighten it.
 */
const SCOPES = ['global', 'engine', 'library', 'category', 'rss_rule', 'torrent'] as const;

export function SchedulerPolicies() {
  const { t } = useTranslation('torrents');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_POLICIES);
  const queryClient = useQueryClient();
  const toast = useToast();

  const policies = useQuery({
    queryKey: ['torrent-scheduler', 'policies'],
    queryFn: api.torrentScheduler.policies,
  });
  const [editing, setEditing] = useState<SchedulerPolicy | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.torrentScheduler.deletePolicy(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] }),
    onError: (e) =>
      toast.error(t('scheduler.policies.deleteFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (policies.isLoading) return <CenteredSpinner />;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">{t('scheduler.policies.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('scheduler.policies.subtitle')}</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('scheduler.policies.add')}
            </Button>
          )}
        </div>

        {!policies.data?.length ? (
          <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-muted-foreground">
            {t('scheduler.policies.none')}
          </p>
        ) : (
          <div className="space-y-2">
            {policies.data.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {!p.enabled && <Badge variant="secondary">{t('scheduler.policies.enabled')}: —</Badge>}
                    <Badge variant="secondary">
                      {t(`scheduler.policies.scopeType.${p.scopeType}` as 'scheduler.policies.scopeType.global')}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {limitLabel(t('scheduler.policies.maxConcurrentDownloads'), p.maxConcurrentDownloads, t('scheduler.policies.unlimited'))}
                    {' · '}
                    {limitLabel(t('scheduler.policies.maxConcurrentSeeds'), p.maxConcurrentSeeds, t('scheduler.policies.unlimited'))}
                    {' · '}
                    {limitLabel(t('scheduler.policies.maxTotalActive'), p.maxTotalActive, t('scheduler.policies.unlimited'))}
                  </div>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      {t('scheduler.policies.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t('scheduler.policies.deleteConfirm'))) remove.mutate(p.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {editing && (
          <PolicyDialog
            policy={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function limitLabel(label: string, value: number | null, unlimited: string): string {
  return `${label}: ${value ?? unlimited}`;
}

function PolicyDialog({
  policy, onClose, onSaved,
}: { policy: SchedulerPolicy | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('torrents');
  const toast = useToast();

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [scopeType, setScopeType] = useState('global');
  const [scopeId, setScopeId] = useState('');
  // Strings, so an empty box is distinguishable from a zero the API rejects.
  const [downloads, setDownloads] = useState('');
  const [seeds, setSeeds] = useState('');
  const [total, setTotal] = useState('');

  useEffect(() => {
    setName(policy?.name ?? '');
    setEnabled(policy?.enabled ?? true);
    setScopeType(policy?.scopeType ?? 'global');
    setScopeId(policy?.scopeId ?? '');
    setDownloads(policy?.maxConcurrentDownloads?.toString() ?? '');
    setSeeds(policy?.maxConcurrentSeeds?.toString() ?? '');
    setTotal(policy?.maxTotalActive?.toString() ?? '');
  }, [policy]);

  // An empty box is an explicit `null` — unlimited — not an omission. That is
  // what lets a narrower policy lift a broader one's cap.
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        enabled,
        scopeType,
        scopeId: scopeType === 'global' ? null : scopeId.trim(),
        maxConcurrentDownloads: num(downloads),
        maxConcurrentSeeds: num(seeds),
        maxTotalActive: num(total),
      };
      return policy
        ? api.torrentScheduler.updatePolicy(policy.id, body)
        : api.torrentScheduler.createPolicy(body);
    },
    onSuccess: onSaved,
    onError: (e) =>
      toast.error(t('scheduler.policies.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} title={t('scheduler.policies.edit')}>
      <DialogHeader>
        <DialogTitle>
          {policy ? t('scheduler.policies.edit') : t('scheduler.policies.add')}
        </DialogTitle>
        <DialogDescription>{t('scheduler.policies.limitsHelp')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="policy-name">{t('scheduler.policies.name')}</Label>
          <Input
            id="policy-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('scheduler.policies.namePlaceholder')}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div>
            <Label htmlFor="policy-scope">{t('scheduler.policies.scope')}</Label>
            <Select
              id="policy-scope"
              className="mt-1 w-auto"
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value)}
            >
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {t(`scheduler.policies.scopeType.${s}` as 'scheduler.policies.scopeType.global')}
                </option>
              ))}
            </Select>
          </div>
          {scopeType !== 'global' && (
            <div className="min-w-[16rem] flex-1">
              <Label htmlFor="policy-scope-id">{t('scheduler.policies.scopeId')}</Label>
              <Input id="policy-scope-id" value={scopeId} onChange={(e) => setScopeId(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">{t('scheduler.policies.scopeIdHelp')}</p>
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold">{t('scheduler.policies.limits')}</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <LimitField
              id="policy-downloads"
              label={t('scheduler.policies.maxConcurrentDownloads')}
              placeholder={t('scheduler.policies.unlimited')}
              value={downloads}
              onChange={setDownloads}
            />
            <LimitField
              id="policy-seeds"
              label={t('scheduler.policies.maxConcurrentSeeds')}
              placeholder={t('scheduler.policies.unlimited')}
              value={seeds}
              onChange={setSeeds}
            />
            <LimitField
              id="policy-total"
              label={t('scheduler.policies.maxTotalActive')}
              placeholder={t('scheduler.policies.unlimited')}
              value={total}
              onChange={setTotal}
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="policy-enabled">{t('scheduler.policies.enabled')}</Label>
          <Switch id="policy-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('scheduler.activation.cancel')}</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <Save className="mr-1.5 h-4 w-4" /> {t('scheduler.policies.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function LimitField({
  id, label, placeholder, value, onChange,
}: { id: string; label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
