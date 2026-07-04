import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  ApiError,
  api,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type UpsertAutomationInput,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
import { Select } from '@/components/ui/select';
import { presetOptions, modeOptions } from './media-manager/constants';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** Loose `t` so builders below can resolve dynamic namespace keys. */
type AnyT = (key: string, options?: Record<string, unknown>) => string;

const TRIGGER_VALUES = ['torrent.completed', 'ratio.reached'] as const;
const triggerKey = (v: string) => `trigger.${v.replace(/\./g, '_')}`;
const triggerLabel = (t: AnyT, v: string) => t(triggerKey(v), { defaultValue: v });
const triggerOptions = (t: AnyT) =>
  TRIGGER_VALUES.map((value) => ({ value, label: triggerLabel(t, value) }));

const FIELDS = ['name', 'label', 'state', 'ratio', 'size', 'progress', 'downloadRate', 'uploadRate'];
// Operator tokens form a compact rule DSL (rendered in monospace) — kept literal.
const OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches /regex/' },
];

const ACTION_TYPE_VALUES = [
  'notify',
  'move',
  'pause',
  'stop',
  'delete',
  'delete_with_data',
  'webhook',
  'rename_for_media',
] as const;
const actionTypeLabel = (t: AnyT, v: string) => t(`actionType.${v}`, { defaultValue: v });
const actionTypeOptions = (t: AnyT) =>
  ACTION_TYPE_VALUES.map((value) => ({ value, label: actionTypeLabel(t, value) }));

function coerce(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

export function AutomationPage() {
  const { t } = useTranslation('automation');
  const tt = t as unknown as AnyT;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<AutomationRule | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['automation'],
    queryFn: api.automation.list,
    refetchInterval: 30000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['automation'] });

  const toBody = (r: AutomationRule): UpsertAutomationInput => ({
    name: r.name,
    description: r.description ?? undefined,
    trigger: r.trigger,
    conditions: r.conditions,
    actions: r.actions,
    isEnabled: r.isEnabled,
    priority: r.priority,
  });

  const toggle = async (rule: AutomationRule) => {
    try {
      await api.automation.update(rule.id, { ...toBody(rule), isEnabled: !rule.isEnabled });
      invalidate();
    } catch (err) {
      toast.error(t('toast.updateError'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const remove = async (rule: AutomationRule) => {
    if (!confirm(t('confirmDelete', { name: rule.name }))) return;
    try {
      await api.automation.remove(rule.id);
      toast.success(t('toast.deleted'), rule.name);
      invalidate();
    } catch (err) {
      toast.error(t('toast.deleteError'), err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('page.subtitle')}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> {t('page.newRule')}
        </Button>
      </div>

      {isLoading ? (
        <CenteredSpinner label={t('page.loading')} />
      ) : isError ? (
        <ErrorState message={t('page.loadError')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Bot className="h-6 w-6" />}
              title={t('page.emptyTitle')}
              description={t('page.emptyDescription')}
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> {t('page.createFirst')}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{rule.name}</p>
                    <Badge variant={rule.isEnabled ? 'success' : 'secondary'} dot>
                      {rule.isEnabled ? t('card.enabled') : t('card.disabled')}
                    </Badge>
                    <Badge variant="outline">
                      <Zap className="h-3 w-3" />
                      {triggerLabel(tt, rule.trigger)}
                    </Badge>
                    {rule.priority > 0 && (
                      <Badge variant="secondary">{t('card.priority', { priority: rule.priority })}</Badge>
                    )}
                  </div>
                  {rule.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {rule.conditions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">{t('card.alwaysNoConditions')}</span>
                    ) : (
                      rule.conditions.map((c, i) => (
                        <code key={i} className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs">
                          {c.field} {OPS.find((o) => o.value === c.op)?.label ?? c.op} {String(c.value)}
                        </code>
                      ))
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {rule.actions.map((a, i) => (
                      <Badge key={i} variant="info">
                        {actionTypeLabel(tt, a.type)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={rule.isEnabled}
                    onCheckedChange={() => toggle(rule)}
                    aria-label={t('card.toggleRule')}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setLogsFor(rule)}>
                    <ScrollText className="h-4 w-4" /> {t('card.logs')}
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('card.edit')} onClick={() => setEditing(rule)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('card.delete')} onClick={() => remove(rule)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <RuleEditor
          rule={editing}
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
      {logsFor && <LogsDialog rule={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function RuleEditor({
  rule,
  onClose,
  onSaved,
}: {
  rule: AutomationRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('automation');
  const tt = t as unknown as AnyT;
  const toast = useToast();
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [trigger, setTrigger] = useState(rule?.trigger ?? TRIGGER_VALUES[0]);
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));
  const [enabled, setEnabled] = useState(rule?.isEnabled ?? true);
  const [conditions, setConditions] = useState<AutomationCondition[]>(
    rule?.conditions ?? [],
  );
  const [actions, setActions] = useState<AutomationAction[]>(
    rule?.actions ?? [{ type: 'notify', params: { message: '' } }],
  );
  const [saving, setSaving] = useState(false);

  const setCondition = (i: number, patch: Partial<AutomationCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const setAction = (i: number, patch: Partial<AutomationAction>) =>
    setActions((as) => as.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));

  const submit = async () => {
    // Validate any destination folders (move/rename actions) against the hard
    // roots and offer to create the missing ones before saving the rule.
    const dirPaths = actions
      .filter((a) => a.type)
      .flatMap((a) => {
        const p = (a.params ?? {}) as Record<string, unknown>;
        return [p.destination, p.libraryPath]
          .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      });
    for (const dir of dirPaths) {
      if (!(await ensureDirectory(dir))) return;
    }
    setSaving(true);
    try {
      const body: UpsertAutomationInput = {
        name: name.trim(),
        description: description.trim() || undefined,
        trigger,
        conditions: conditions
          .filter((c) => c.field)
          .map((c) => ({ ...c, value: coerce(String(c.value)) })),
        actions: actions.filter((a) => a.type),
        isEnabled: enabled,
        priority: Number(priority) || 0,
      };
      if (rule) await api.automation.update(rule.id, body);
      else await api.automation.create(body);
      toast.success(rule ? t('toast.updated') : t('toast.created'), body.name);
      onSaved();
    } catch (err) {
      toast.error(t('toast.saveError'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{rule ? t('editor.editTitle') : t('editor.newTitle')}</DialogTitle>
        <DialogDescription>
          {t('editor.description')}
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ar-name">{t('editor.name')}</Label>
            <Input id="ar-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('editor.namePlaceholder')} />
          </div>
          <div>
            <Label htmlFor="ar-priority">{t('editor.priority')}</Label>
            <Input id="ar-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="ar-desc">{t('editor.descriptionLabel')}</Label>
          <Input id="ar-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ar-trigger">{t('editor.trigger')}</Label>
            <Select id="ar-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)} options={triggerOptions(tt)} />
            {trigger === 'ratio.reached' && (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans t={t} i18nKey="editor.ratioHint" components={{ code: <code />, em: <em /> }} />
              </p>
            )}
          </div>
          <div className="flex items-end justify-between">
            <Label htmlFor="ar-enabled">{t('editor.enabled')}</Label>
            <Switch id="ar-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        {/* Conditions */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t('editor.conditionsTitle')} <span className="text-muted-foreground">{t('editor.conditionsHint')}</span></p>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setConditions((c) => [...c, { field: 'name', op: 'contains', value: '' }])}
            >
              <Plus className="h-4 w-4" /> {t('editor.add')}
            </Button>
          </div>
          {conditions.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('editor.noConditions')}</p>
          )}
          {conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={c.field}
                onChange={(e) => setCondition(i, { field: e.target.value })}
                options={FIELDS.map((f) => ({ value: f, label: f }))}
                className="w-36"
              />
              <Select
                value={c.op}
                onChange={(e) => setCondition(i, { op: e.target.value })}
                options={OPS}
                className="w-40"
              />
              <Input
                value={String(c.value)}
                onChange={(e) => setCondition(i, { value: e.target.value })}
                placeholder={t('editor.valuePlaceholder')}
                className="flex-1"
              />
              <Button variant="ghost" size="icon" aria-label={t('editor.removeCondition')} onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t('editor.actionsTitle')} <span className="text-muted-foreground">{t('editor.actionsHint')}</span></p>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setActions((a) => [...a, { type: 'notify', params: { message: '' } }])}
            >
              <Plus className="h-4 w-4" /> {t('editor.add')}
            </Button>
          </div>
          {actions.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={a.type}
                onChange={(e) => setAction(i, { type: e.target.value, params: {} })}
                options={actionTypeOptions(tt)}
                className="w-52"
              />
              <ActionParams action={a} onChange={(params) => setAction(i, { params })} />
              <Button variant="ghost" size="icon" aria-label={t('editor.removeAction')} onClick={() => setActions((as) => as.filter((_, idx) => idx !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('editor.cancel')}</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || actions.length === 0}>
          {rule ? t('editor.saveChanges') : t('editor.createRule')}
        </Button>
      </DialogFooter>
    </Dialog>
    {ensureDirectoryDialog}
    </>
  );
}

function ActionParams({
  action,
  onChange,
}: {
  action: AutomationAction;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation('automation');
  const tt = t as unknown as AnyT;
  const p = action.params ?? {};
  const set = (key: string, value: string) => onChange({ ...p, [key]: value });

  if (action.type === 'move') {
    return (
      <PathPicker
        value={String(p.destination ?? '')}
        onChange={(v) => set('destination', v)}
        placeholder={t('params.destinationPlaceholder')}
        aria-label={t('params.destinationAria')}
        pickerTitle={t('params.destinationPicker')}
        className="flex-1"
      />
    );
  }
  if (action.type === 'notify') {
    return <Input value={String(p.message ?? '')} onChange={(e) => set('message', e.target.value)} placeholder={t('params.messagePlaceholder')} className="flex-1" />;
  }
  if (action.type === 'webhook') {
    return <Input value={String(p.url ?? '')} onChange={(e) => set('url', e.target.value)} placeholder={t('params.webhookPlaceholder')} className="flex-1 font-mono" />;
  }
  if (action.type === 'rename_for_media') {
    return (
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <Select
          value={String(p.preset ?? 'plex')}
          onChange={(e) => set('preset', e.target.value)}
          options={presetOptions(tt as never)}
          className="w-32"
        />
        <Select
          value={String(p.mode ?? 'rename_move')}
          onChange={(e) => set('mode', e.target.value)}
          options={modeOptions(tt as never)}
          className="w-44"
        />
        <PathPicker
          value={String(p.libraryPath ?? '')}
          onChange={(v) => set('libraryPath', v)}
          placeholder={t('params.libraryPathPlaceholder')}
          aria-label={t('params.libraryPathAria')}
          pickerTitle={t('params.libraryPathPicker')}
          className="min-w-[10rem] flex-1"
        />
        <Input
          value={String(p.template ?? '')}
          onChange={(e) => set('template', e.target.value)}
          placeholder={t('params.templatePlaceholder')}
          className="min-w-[10rem] flex-1 font-mono"
        />
      </div>
    );
  }
  return <div className="flex-1 text-xs text-muted-foreground">{t('params.noParameters')}</div>;
}

function LogsDialog({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const { t } = useTranslation('automation');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['automation', 'logs', rule.id],
    queryFn: () => api.automation.logs(rule.id),
  });

  const badge = (status: string) =>
    status === 'success' ? 'success' : status === 'failed' ? 'destructive' : 'secondary';

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('logs.title', { name: rule.name })}</DialogTitle>
        <DialogDescription>{t('logs.description')}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-y-auto py-2">
        {isLoading ? (
          <CenteredSpinner label={t('logs.loading')} />
        ) : isError ? (
          <ErrorState message={t('logs.loadError')} onRetry={() => refetch()} />
        ) : !data || data.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-6 w-6" />} title={t('logs.emptyTitle')} description={t('logs.emptyDescription')} />
        ) : (
          <ul className="divide-y divide-border/60">
            {data.map((log) => (
              <li key={log.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{log.message ?? (log.context?.name as string) ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{formatRelativeTime(log.createdAt)}</p>
                </div>
                <Badge variant={badge(log.status)} dot>{(t as unknown as AnyT)(`logStatus.${log.status}`, { defaultValue: log.status })}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('logs.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
