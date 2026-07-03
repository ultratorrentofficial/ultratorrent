import { useState } from 'react';
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
import { Select } from '@/components/ui/select';
import { PRESET_OPTIONS, MODE_OPTIONS } from './MediaPage';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const TRIGGERS = [
  { value: 'torrent.completed', label: 'When a download completes' },
  { value: 'ratio.reached', label: 'When the share ratio is reached' },
];

const FIELDS = ['name', 'label', 'state', 'ratio', 'size', 'progress', 'downloadRate', 'uploadRate'];
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
const ACTION_TYPES = [
  { value: 'notify', label: 'Send notification' },
  { value: 'move', label: 'Move data' },
  { value: 'pause', label: 'Pause torrent' },
  { value: 'stop', label: 'Stop torrent' },
  { value: 'delete', label: 'Remove torrent' },
  { value: 'delete_with_data', label: 'Remove torrent + data' },
  { value: 'webhook', label: 'Call webhook' },
  { value: 'rename_for_media', label: 'Rename for media server' },
];

function coerce(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

export function AutomationPage() {
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
      toast.error('Could not update rule', err instanceof ApiError ? err.message : undefined);
    }
  };

  const remove = async (rule: AutomationRule) => {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await api.automation.remove(rule.id);
      toast.success('Rule deleted', rule.name);
      invalidate();
    } catch (err) {
      toast.error('Could not delete rule', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Automation</h1>
          <p className="text-sm text-muted-foreground">
            Rules run when their trigger fires and every condition matches.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New rule
        </Button>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading rules…" />
      ) : isError ? (
        <ErrorState message="Could not load automation rules." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Bot className="h-6 w-6" />}
              title="No automation rules"
              description="Create a rule to react to completed downloads — move data, notify, clean up, and more."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Create your first rule
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
                      {rule.isEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    <Badge variant="outline">
                      <Zap className="h-3 w-3" />
                      {TRIGGERS.find((t) => t.value === rule.trigger)?.label ?? rule.trigger}
                    </Badge>
                    {rule.priority > 0 && <Badge variant="secondary">priority {rule.priority}</Badge>}
                  </div>
                  {rule.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {rule.conditions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">always (no conditions)</span>
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
                        {ACTION_TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={rule.isEnabled}
                    onCheckedChange={() => toggle(rule)}
                    aria-label="Toggle rule"
                  />
                  <Button variant="ghost" size="sm" onClick={() => setLogsFor(rule)}>
                    <ScrollText className="h-4 w-4" /> Logs
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(rule)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => remove(rule)}>
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
  const toast = useToast();
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [trigger, setTrigger] = useState(rule?.trigger ?? TRIGGERS[0].value);
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
      toast.success(rule ? 'Rule updated' : 'Rule created', body.name);
      onSaved();
    } catch (err) {
      toast.error('Could not save rule', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{rule ? 'Edit rule' : 'New automation rule'}</DialogTitle>
        <DialogDescription>
          When the trigger fires, the rule runs its actions if every condition matches.
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ar-name">Name</Label>
            <Input id="ar-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Seed then notify" />
          </div>
          <div>
            <Label htmlFor="ar-priority">Priority</Label>
            <Input id="ar-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="ar-desc">Description (optional)</Label>
          <Input id="ar-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ar-trigger">Trigger</Label>
            <Select id="ar-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)} options={TRIGGERS} />
            {trigger === 'ratio.reached' && (
              <p className="mt-1 text-xs text-muted-foreground">
                Add a <code>ratio ≥ N</code> condition (e.g. <code>ratio gte 2</code>). Fires once
                when a torrent first reaches it — pair with a <em>stop</em> or <em>delete</em> action
                to cap seeding.
              </p>
            )}
          </div>
          <div className="flex items-end justify-between">
            <Label htmlFor="ar-enabled">Enabled</Label>
            <Switch id="ar-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        {/* Conditions */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Conditions <span className="text-muted-foreground">(all must match)</span></p>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setConditions((c) => [...c, { field: 'name', op: 'contains', value: '' }])}
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          {conditions.length === 0 && (
            <p className="text-xs text-muted-foreground">No conditions — the rule always runs on its trigger.</p>
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
                placeholder="value"
                className="flex-1"
              />
              <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Actions <span className="text-muted-foreground">(run in order)</span></p>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setActions((a) => [...a, { type: 'notify', params: { message: '' } }])}
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          {actions.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={a.type}
                onChange={(e) => setAction(i, { type: e.target.value, params: {} })}
                options={ACTION_TYPES}
                className="w-52"
              />
              <ActionParams action={a} onChange={(params) => setAction(i, { params })} />
              <Button variant="ghost" size="icon" aria-label="Remove action" onClick={() => setActions((as) => as.filter((_, idx) => idx !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || actions.length === 0}>
          {rule ? 'Save changes' : 'Create rule'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ActionParams({
  action,
  onChange,
}: {
  action: AutomationAction;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const p = action.params ?? {};
  const set = (key: string, value: string) => onChange({ ...p, [key]: value });

  if (action.type === 'move') {
    return (
      <PathPicker
        value={String(p.destination ?? '')}
        onChange={(v) => set('destination', v)}
        placeholder="/downloads/done"
        aria-label="Destination folder"
        pickerTitle="Choose a destination folder"
        className="flex-1"
      />
    );
  }
  if (action.type === 'notify') {
    return <Input value={String(p.message ?? '')} onChange={(e) => set('message', e.target.value)} placeholder="message" className="flex-1" />;
  }
  if (action.type === 'webhook') {
    return <Input value={String(p.url ?? '')} onChange={(e) => set('url', e.target.value)} placeholder="https://…" className="flex-1 font-mono" />;
  }
  if (action.type === 'rename_for_media') {
    return (
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <Select
          value={String(p.preset ?? 'plex')}
          onChange={(e) => set('preset', e.target.value)}
          options={PRESET_OPTIONS}
          className="w-32"
        />
        <Select
          value={String(p.mode ?? 'rename_move')}
          onChange={(e) => set('mode', e.target.value)}
          options={MODE_OPTIONS}
          className="w-44"
        />
        <PathPicker
          value={String(p.libraryPath ?? '')}
          onChange={(v) => set('libraryPath', v)}
          placeholder="/media/tv"
          aria-label="Library path"
          pickerTitle="Choose a library folder"
          className="min-w-[10rem] flex-1"
        />
        <Input
          value={String(p.template ?? '')}
          onChange={(e) => set('template', e.target.value)}
          placeholder="template (optional)"
          className="min-w-[10rem] flex-1 font-mono"
        />
      </div>
    );
  }
  return <div className="flex-1 text-xs text-muted-foreground">No parameters</div>;
}

function LogsDialog({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['automation', 'logs', rule.id],
    queryFn: () => api.automation.logs(rule.id),
  });

  const badge = (status: string) =>
    status === 'success' ? 'success' : status === 'failed' ? 'destructive' : 'secondary';

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Execution log — {rule.name}</DialogTitle>
        <DialogDescription>Every time this rule ran.</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-y-auto py-2">
        {isLoading ? (
          <CenteredSpinner label="Loading logs…" />
        ) : isError ? (
          <ErrorState message="Could not load logs." onRetry={() => refetch()} />
        ) : !data || data.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-6 w-6" />} title="No runs yet" description="Entries appear here once the rule fires." />
        ) : (
          <ul className="divide-y divide-border/60">
            {data.map((log) => (
              <li key={log.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{log.message ?? (log.context?.name as string) ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{formatRelativeTime(log.createdAt)}</p>
                </div>
                <Badge variant={badge(log.status)} dot>{log.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}
