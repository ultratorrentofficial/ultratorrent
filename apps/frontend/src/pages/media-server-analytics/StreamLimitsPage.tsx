import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users2, Pencil, Link2, Unlink, UserPlus } from 'lucide-react';
import { api, type StreamPolicyRow, type StreamCandidate, type StreamEnforcementAction, type StreamEnforcementScope } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { MediaServerIcon } from '@/components/media-servers/MediaServerIcon';

const ACTIONS: StreamEnforcementAction[] = ['terminate_newest', 'terminate_oldest', 'warn', 'log'];
const SCOPES: StreamEnforcementScope[] = ['all_servers', 'per_server'];

/**
 * Per-user stream limits. The list holds ONLY viewers an admin has deliberately
 * configured (an override, an exemption, or a link) — not every viewer. Use "Add
 * user" to pick someone and give them an override.
 */
export function StreamLimitsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const rows = useQuery({ queryKey: ['streamControl', 'policies'], queryFn: () => api.mediaServerAnalytics.streamControl.policies() });
  const [editing, setEditing] = useState<StreamPolicyRow | null>(null);
  const [adding, setAdding] = useState<StreamCandidate | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const link = useMutation({
    mutationFn: () => api.mediaServerAnalytics.streamControl.link([...selected]),
    onSuccess: () => { toast.success(t('streamControl.link.linked')); setSelected(new Set()); void qc.invalidateQueries({ queryKey: ['streamControl'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.streamControl.unlink(id),
    onSuccess: () => { toast.success(t('streamControl.link.unlinked')); void qc.invalidateQueries({ queryKey: ['streamControl'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = rows.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Users2 className="h-6 w-6" /> {t('streamControl.limits.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('streamControl.limits.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size >= 2 && (
            <Button variant="secondary" onClick={() => link.mutate()} disabled={link.isPending}>
              <Link2 className="h-4 w-4" /> {t('streamControl.link.linkSelected', { count: selected.size })}
            </Button>
          )}
          <Button onClick={() => setPickerOpen(true)}>
            <UserPlus className="h-4 w-4" /> {t('streamControl.limits.addUser')}
          </Button>
        </div>
      </div>

      {rows.isLoading ? (
        <CenteredSpinner />
      ) : rows.isError ? (
        <ErrorState title={t('streamControl.limits.loadError')} onRetry={() => void rows.refetch()} />
      ) : list.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <EmptyState title={t('streamControl.limits.empty')} description={t('streamControl.limits.emptyHint')} />
          <Button onClick={() => setPickerOpen(true)}><UserPlus className="h-4 w-4" /> {t('streamControl.limits.addUser')}</Button>
        </CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-white/10 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2" />
                    <th className="px-4 py-2">{t('streamControl.limits.colUser')}</th>
                    <th className="px-4 py-2">{t('streamControl.limits.colActive')}</th>
                    <th className="px-4 py-2">{t('streamControl.limits.colLimit')}</th>
                    <th className="px-4 py-2">{t('streamControl.limits.colStatus')}</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.mediaAnalyticsUserId} className="border-b border-white/5">
                      <td className="px-4 py-2">
                        <Checkbox checked={selected.has(r.mediaAnalyticsUserId)} onCheckedChange={() => toggle(r.mediaAnalyticsUserId)} aria-label={t('streamControl.link.select')} />
                      </td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2">
                          <MediaServerIcon kind={r.kind} className="h-4 w-4" />
                          <span className="font-medium">{r.displayName ?? r.providerUserId}</span>
                          {r.groupId && (
                            <span className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={t('streamControl.link.linkedTitle')}>
                              <Link2 className="h-3 w-3" /> {t('streamControl.link.linked')}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{r.activeStreams}</td>
                      <td className="px-4 py-2 tabular-nums">{limitLabel(r, t)}</td>
                      <td className="px-4 py-2"><StatusPill r={r} t={t} /></td>
                      <td className="px-4 py-2 text-right">
                        <span className="flex justify-end gap-1">
                          {r.groupId && (
                            <Button variant="ghost" size="sm" onClick={() => unlink.mutate(r.mediaAnalyticsUserId)} disabled={unlink.isPending} title={t('streamControl.link.unlink')}>
                              <Unlink className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                            <Pencil className="h-3.5 w-3.5" /> {t('streamControl.limits.edit')}
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {pickerOpen && (
        <CandidatePicker
          onClose={() => setPickerOpen(false)}
          onPick={(c) => { setPickerOpen(false); setAdding(c); }}
        />
      )}
      {editing && <PolicyEditor existing={editing} onClose={() => setEditing(null)} />}
      {adding && <PolicyEditor candidate={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function limitLabel(r: StreamPolicyRow, t: TFunction<'mediaServerAnalytics'>): string {
  if (r.exemptFromLimits) return t('streamControl.limits.exempt');
  if (r.limit == null) return t('streamControl.limit.unlimited');
  return String(r.limit);
}

function StatusPill({ r, t }: { r: StreamPolicyRow; t: TFunction<'mediaServerAnalytics'> }) {
  const [label, cls] = r.exemptFromLimits
    ? [t('streamControl.status.exempt'), 'text-muted-foreground border-white/10']
    : r.limit == null
      ? [t('streamControl.status.unlimited'), 'text-muted-foreground border-white/10']
      : r.overLimit
        ? [t('streamControl.status.over'), 'text-destructive border-destructive/40']
        : r.activeStreams >= r.limit
          ? [t('streamControl.status.atLimit'), 'text-warning border-warning/40']
          : [t('streamControl.status.ok'), 'text-success border-success/30'];
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

/** Pick a known viewer who does not yet have an override. */
function CandidatePicker({ onClose, onPick }: { onClose: () => void; onPick: (c: StreamCandidate) => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const [q, setQ] = useState('');
  const candidates = useQuery({ queryKey: ['streamControl', 'candidates'], queryFn: () => api.mediaServerAnalytics.streamControl.candidates() });
  const filtered = (candidates.data ?? []).filter((c) => (c.displayName ?? c.providerUserId).toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Dialog open onClose={onClose} title={t('streamControl.picker.title')}>
      <div className="space-y-3">
        <Input placeholder={t('streamControl.picker.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {candidates.isLoading ? (
          <CenteredSpinner />
        ) : candidates.isError ? (
          <ErrorState title={t('streamControl.picker.loadError')} onRetry={() => void candidates.refetch()} />
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('streamControl.picker.empty')}</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((c) => (
              <button
                key={`${c.kind}:${c.providerUserId}`}
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-white/5"
              >
                <MediaServerIcon kind={c.kind} className="h-4 w-4" />
                <span className="font-medium">{c.displayName ?? c.providerUserId}</span>
                <span className="ml-auto text-xs capitalize text-muted-foreground">{c.kind}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('streamControl.limits.cancel')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

type Mode = 'default' | 'unlimited' | 'custom';

/** Edit an existing override, or configure a new one for a picked candidate. */
function PolicyEditor({ existing, candidate, onClose }: { existing?: StreamPolicyRow; candidate?: StreamCandidate; onClose: () => void }) {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = !existing;
  const name = existing ? existing.displayName ?? existing.providerUserId : candidate!.displayName ?? candidate!.providerUserId;

  const initialMode: Mode = existing?.policy == null ? (isNew ? 'custom' : 'default') : existing.policy.maxConcurrentStreams == null ? 'unlimited' : 'custom';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [value, setValue] = useState(existing?.policy?.maxConcurrentStreams ?? 2);
  const [action, setAction] = useState<StreamEnforcementAction | ''>(existing?.policy?.enforcementAction ?? '');
  const [scope, setScope] = useState<StreamEnforcementScope | ''>(existing?.policy?.scope ?? '');
  const [exempt, setExempt] = useState(existing?.exemptFromLimits ?? false);

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        await api.mediaServerAnalytics.streamControl.addPolicy({
          kind: candidate!.kind,
          providerUserId: candidate!.providerUserId,
          displayName: candidate!.displayName,
          ...(exempt
            ? { exempt: true }
            : { maxConcurrentStreams: mode === 'unlimited' ? null : Math.max(1, Math.min(100, value)), enforcementAction: action || null, scope: scope || null }),
        });
        return;
      }
      const row = existing!;
      if (exempt !== row.exemptFromLimits) await api.mediaServerAnalytics.streamControl.setExempt(row.mediaAnalyticsUserId, exempt);
      if (exempt) return;
      if (mode === 'default') {
        if (row.policy) await api.mediaServerAnalytics.streamControl.deletePolicy(row.mediaAnalyticsUserId);
      } else {
        await api.mediaServerAnalytics.streamControl.putPolicy(row.mediaAnalyticsUserId, {
          maxConcurrentStreams: mode === 'unlimited' ? null : Math.max(1, Math.min(100, value)),
          enforcementAction: action || null,
          scope: scope || null,
          enabled: true,
        });
      }
    },
    onSuccess: () => {
      toast.success(t('streamControl.limits.saved'));
      void qc.invalidateQueries({ queryKey: ['streamControl'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onClose={onClose} title={t(isNew ? 'streamControl.limits.addFor' : 'streamControl.limits.editFor', { name })}>
      <div className="space-y-4">
        <label className="flex items-center justify-between gap-4">
          <span className="font-medium">{t('streamControl.limits.exemptToggle')}</span>
          <Switch checked={exempt} onCheckedChange={setExempt} aria-label={t('streamControl.limits.exemptToggle')} />
        </label>

        {!exempt && (
          <>
            <div>
              <Label>{t('streamControl.settings.defaultLimit')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                  {/* A brand-new override must actually set something; "use default" only
                      makes sense when clearing an existing one. */}
                  {!isNew && <option value="default">{t('streamControl.limit.useDefault')}</option>}
                  <option value="unlimited">{t('streamControl.limit.unlimited')}</option>
                  <option value="custom">{t('streamControl.limit.custom')}</option>
                </Select>
                {mode === 'custom' && (
                  <Input type="number" min={1} max={100} className="w-24" value={value}
                    onChange={(e) => setValue(Math.max(1, Math.min(100, Number.parseInt(e.target.value, 10) || 1)))} />
                )}
              </div>
            </div>

            {mode !== 'default' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>{t('streamControl.settings.defaultAction')}</Label>
                  <Select className="mt-1" value={action} onChange={(e) => setAction(e.target.value as StreamEnforcementAction | '')}>
                    <option value="">{t('streamControl.limit.inherit')}</option>
                    {ACTIONS.map((a) => <option key={a} value={a}>{t(`streamControl.action.${a}`)}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>{t('streamControl.settings.scope')}</Label>
                  <Select className="mt-1" value={scope} onChange={(e) => setScope(e.target.value as StreamEnforcementScope | '')}>
                    <option value="">{t('streamControl.limit.inherit')}</option>
                    {SCOPES.map((s) => <option key={s} value={s}>{t(`streamControl.scope.${s}`)}</option>)}
                  </Select>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={save.isPending}>{t('streamControl.limits.cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('streamControl.settings.saving') : t('streamControl.settings.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
