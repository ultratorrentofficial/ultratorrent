import { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { ApiError, api, type SchedulerPolicy, type SchedulerSeedPolicy } from '@/lib/api';
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
import { ConditionBuilder, type ConditionGroup } from '@/components/conditions/ConditionBuilder';

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
  // Only the enforceable subset is offered — see the seeding help text.
  const [afterTarget, setAfterTarget] = useState<SchedulerSeedPolicy['afterTarget']>('pause');
  const [requireImport, setRequireImport] = useState(true);
  /*
   * Which torrents this policy's seeding rules apply to.
   *
   * Null means "every torrent in scope", which is what a policy did before
   * conditions existed — so an existing one opens unchanged rather than
   * appearing to have gained an empty rule.
   */
  const EMPTY_CONDITIONS: ConditionGroup = { type: 'all', children: [] };
  const [seedConditions, setSeedConditions] = useState<ConditionGroup>(EMPTY_CONDITIONS);
  /*
   * Served by the backend rather than duplicated here: a field the evaluator
   * does not know produces a policy that saves, validates and then matches
   * nothing — silently, because "unknown field" and "nothing matched" look
   * identical from outside.
   */
  const seedCatalog = useQuery({
    queryKey: ['torrent-scheduler', 'seed-conditions'],
    queryFn: api.torrentScheduler.seedConditions,
    staleTime: 5 * 60_000,
  });


  const [downKbps, setDownKbps] = useState('');
  const [upKbps, setUpKbps] = useState('');

  /*
   * What the chosen scope can point at.
   *
   * Fetched only for the scope in play — opening the dialog on `global` should
   * not pull three lists nobody asked for. `torrent` deliberately has no query:
   * an info-hash is pasted, not chosen, and listing every torrent to pick one
   * would be a worse control than the text box.
   */
  const libraries = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: () => api.media.libraries(),
    enabled: scopeType === 'library',
  });
  const engines = useQuery({
    queryKey: ['engines'],
    queryFn: () => api.engines.list(),
    enabled: scopeType === 'engine',
  });
  const rssRules = useQuery({
    queryKey: ['rss', 'rules'],
    queryFn: () => api.rss.rules(),
    enabled: scopeType === 'rss_rule',
  });

  /** `null` means "no list exists for this scope — let them type". */
  const scopeOptions: { id: string; label: string }[] | null =
    scopeType === 'library'
      ? (libraries.data ?? []).map((l) => ({ id: l.id, label: l.name }))
      : scopeType === 'engine'
        ? (engines.data ?? []).map((e) => ({ id: e.id, label: `${e.name} (${e.kind})` }))
        : scopeType === 'rss_rule'
          ? (rssRules.data ?? []).map((r) => ({ id: r.id, label: r.name }))
          : null;

  useEffect(() => {
    setName(policy?.name ?? '');
    setEnabled(policy?.enabled ?? true);
    setScopeType(policy?.scopeType ?? 'global');
    setScopeId(policy?.scopeId ?? '');
    setDownloads(policy?.maxConcurrentDownloads?.toString() ?? '');
    setSeeds(policy?.maxConcurrentSeeds?.toString() ?? '');
    setTotal(policy?.maxTotalActive?.toString() ?? '');
    setAfterTarget(policy?.seedPolicy?.afterTarget ?? 'pause');
    // Defaults ON: the usual reason to seed past completion is that the library
    // copy is not safe yet, so waiting for the import is the safe default.
    setRequireImport(policy?.seedPolicy?.requireImportCompleted ?? true);
    /*
     * A policy written before this said its target in fixed fields. Rendering
     * it as the equivalent list means opening one shows the rule it actually
     * has — and saving migrates it — rather than showing an empty builder
     * beside a target the form can no longer display.
     */
    const stored = policy?.seedPolicy?.stopWhen as ConditionGroup | null | undefined;
    if (stored) {
      setSeedConditions(stored);
    } else {
      const migrated: ConditionGroup = { type: 'any', children: [] };
      const ratio = policy?.seedPolicy?.targetRatio;
      if (policy?.seedPolicy?.mode === 'ratio' && typeof ratio === 'number' && ratio > 0) {
        migrated.children.push({ type: 'condition', field: 'seed.ratio', operator: 'gte', value: ratio });
      }
      const age = policy?.seedPolicy?.maxAgeDays;
      if (typeof age === 'number' && age > 0) {
        migrated.children.push({ type: 'condition', field: 'seed.ageDays', operator: 'gte', value: age });
      }
      setSeedConditions(migrated);
    }
    setDownKbps(policy?.maxDownloadRateKbps?.toString() ?? '');
    setUpKbps(policy?.maxUploadRateKbps?.toString() ?? '');
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
        maxDownloadRateKbps: num(downKbps),
        maxUploadRateKbps: num(upKbps),
        seedPolicy: {
          /*
           * `mode` is kept only because the API still requires one; the list is
           * what decides. `manual` is the honest value — nothing here sets a
           * fixed ratio target any more.
           */
          mode: (seedConditions.children.length ? 'manual' : 'unlimited') as SchedulerSeedPolicy['mode'],
          afterTarget,
          requireImportCompleted: requireImport,
          stopWhen: seedConditions.children.length ? seedConditions : null,
        },
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
              onChange={(e) => {
                setScopeType(e.target.value);
                // An id belongs to exactly one scope. Carrying a library id over
                // to `rss_rule` would leave the box looking filled while naming
                // nothing that scope can match.
                setScopeId('');
              }}
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
              {scopeOptions ? (
                /*
                 * Pick from what exists. Every scope but `torrent` names a row
                 * the platform already knows, and typing its id by hand could
                 * only ever produce a policy that matches nothing — saved
                 * happily, then silently governing no torrent. The one id an
                 * operator legitimately types is an info-hash, which is pasted
                 * from elsewhere and has no list to choose from.
                 */
                <Select
                  id="policy-scope-id"
                  className="mt-1"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                >
                  <option value="">{t('scheduler.policies.scopePick')}</option>
                  {scopeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="policy-scope-id"
                  className="mt-1"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  placeholder={t('scheduler.policies.scopeHashPlaceholder')}
                />
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {scopeOptions && scopeOptions.length === 0
                  ? t('scheduler.policies.scopeNone')
                  : t('scheduler.policies.scopeIdHelp')}
              </p>
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

        <div>
          <h3 className="text-sm font-semibold">{t('scheduler.policies.bandwidth.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('scheduler.policies.bandwidth.help')}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <LimitField
              id="policy-down-kbps"
              label={t('scheduler.policies.bandwidth.maxDownloadRateKbps')}
              placeholder={t('scheduler.policies.unlimited')}
              value={downKbps}
              onChange={setDownKbps}
            />
            <LimitField
              id="policy-up-kbps"
              label={t('scheduler.policies.bandwidth.maxUploadRateKbps')}
              placeholder={t('scheduler.policies.unlimited')}
              value={upKbps}
              onChange={setUpKbps}
            />
          </div>
          {/* Said where the fields are, so nobody looks for a split that cannot
              exist on these engines. */}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('scheduler.policies.bandwidth.reserveNote')}
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold">{t('scheduler.policies.seeding.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('scheduler.policies.seeding.help')}</p>

          {/*
            * "Stop seeding when" IS the condition list.
            *
            * It replaces a mode dropdown that could only ever say one thing —
            * a ratio, or nothing — so "ratio 2 OR 30 days, but not before the
            * import finished" could not be written at all.
            */}
          <div className="mt-3">
            <Label>{t('scheduler.policies.seeding.stopWhen')}</Label>
            <p className="mb-2 text-xs text-muted-foreground">
              {t('scheduler.policies.seeding.stopWhenHint')}
            </p>
            <ConditionBuilder
              namespace="torrents"
              node={seedConditions}
              catalog={seedCatalog.data ?? []}
              onChange={setSeedConditions}
            />
            {seedConditions.children.length === 0 && (
              <p className="mt-2 text-xs text-warning">
                {t('scheduler.policies.seeding.stopWhenEmpty')}
              </p>
            )}
          </div>

          <div className="mt-3">
            <Label htmlFor="seed-after">{t('scheduler.policies.seeding.afterTarget')}</Label>
            <Select
              id="seed-after"
              className="mt-1 w-auto"
              value={afterTarget}
              onChange={(e) => setAfterTarget(e.target.value as SchedulerSeedPolicy['afterTarget'])}
            >
              {(['pause', 'stop', 'leave_active', 'remove_torrent_and_staging_data'] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`scheduler.policies.seeding.afterTargetOption.${a}` as 'scheduler.policies.seeding.afterTargetOption.pause')}
                </option>
              ))}
            </Select>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('scheduler.policies.seeding.afterTargetHelp')}
            </p>
            {afterTarget === 'remove_torrent_and_staging_data' && (
              <p className="mt-1 text-xs text-warning">
                {t('scheduler.policies.seeding.removeWarning')}
              </p>
            )}
          </div>

          {/* A safety gate, not a target: it can only DELAY the action above. */}
          <div className="mt-2 flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <div>
              <Label htmlFor="seed-require-import">
                {t('scheduler.policies.seeding.requireImportCompleted')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('scheduler.policies.seeding.safetyHelp')}
              </p>
            </div>
            <Switch
              id="seed-require-import"
              checked={requireImport}
              onCheckedChange={setRequireImport}
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
