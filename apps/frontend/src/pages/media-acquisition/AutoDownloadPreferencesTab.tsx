import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, GripVertical, HardDriveDownload, Plus, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError, type AcquisitionMatchCandidate, type MatchCandidateInput } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

const QK = ['media-acquisition', 'match-preferences'];
const MB = 1024 * 1024;
const bytesToMb = (b?: number) => (b == null ? '' : String(Math.round(b / MB)));
const mbToBytes = (mb: string) => { const n = Number(mb); return Number.isFinite(n) && n > 0 ? Math.round(n * MB) : undefined; };
const termsToText = (t: string[]) => t.join(', ');
const textToTerms = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Editor for the global auto-download match preferences — the ranked candidate
 * ladder (quality + size cap) that drives EVERY missing-episode and pack auto-grab.
 * Walked top-to-bottom: the sweep grabs the release matching the highest rung it
 * satisfies, falling to the next rung when nothing qualifies. Rows can be re-ranked
 * in place — drag by the grip handle, or use the up/down arrows (a drag-free path
 * for keyboard/a11y) — with no delete-and-recreate. Mirrors the RSS rule match
 * candidate list.
 */
export function AutoDownloadPreferencesTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_MANAGE_PROFILES);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AcquisitionMatchCandidate | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const q = useQuery({ queryKey: QK, queryFn: () => api.mediaAcquisition.matchPreferences() });
  const items = q.data ?? [];

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.mediaAcquisition.removeMatchPreference(id),
    onSuccess: () => { toast.success(t('acquisition.autoDownload.toast.deleted')); queryClient.invalidateQueries({ queryKey: QK }); },
    onError: (e) => toast.error(t('acquisition.autoDownload.toast.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  // Persist a new order. Optimistic (like the RSS rule candidate list): renumber
  // priorityOrder locally so the drop lands instantly, then reconcile with the
  // server's echo — or roll back on error.
  const persistReorder = async (orderedIds: string[]) => {
    const previous = queryClient.getQueryData<AcquisitionMatchCandidate[]>(QK);
    if (previous) {
      const byId = new Map(previous.map((c) => [c.id, c]));
      const optimistic = orderedIds
        .map((id, idx) => { const c = byId.get(id); return c ? { ...c, priorityOrder: idx } : null; })
        .filter((c): c is AcquisitionMatchCandidate => c != null);
      queryClient.setQueryData(QK, optimistic);
    }
    try {
      const updated = await api.mediaAcquisition.reorderMatchPreferences(orderedIds);
      queryClient.setQueryData(QK, updated);
    } catch (e) {
      if (previous) queryClient.setQueryData(QK, previous);
      toast.error(t('acquisition.autoDownload.toast.saveFailed'), e instanceof ApiError ? e.message : undefined);
    }
  };

  // Move `fromId` to `toId`'s slot, preserving the rest of the order.
  const reorderIds = (ids: string[], fromId: string, toId: string): string[] => {
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    return next;
  };

  // Keyboard/click reorder (the up/down arrows) — a drag-free path for a11y.
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= items.length) return;
    void persistReorder(reorderIds(items.map((c) => c.id), items[index].id, items[j].id));
  };

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    void persistReorder(reorderIds(items.map((c) => c.id), dragId, targetId));
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('acquisition.autoDownload.intro')}</p>
        {canManage && (
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> {t('acquisition.autoDownload.add')}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <CenteredSpinner label={t('acquisition.autoDownload.loading')} />
          ) : q.isError ? (
            <ErrorState message={t('acquisition.autoDownload.error')} onRetry={() => q.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<HardDriveDownload className="h-6 w-6" />} title={t('acquisition.autoDownload.emptyTitle')} description={t('acquisition.autoDownload.emptyBody')} />
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((c, i) => (
                <li
                  key={c.id}
                  draggable={canManage}
                  onDragStart={canManage ? (e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(c.id); } : undefined}
                  onDragEnter={canManage ? () => setOverId(c.id) : undefined}
                  onDragOver={canManage ? (e) => e.preventDefault() : undefined}
                  onDragEnd={canManage ? () => { setDragId(null); setOverId(null); } : undefined}
                  onDrop={canManage ? (e) => { e.preventDefault(); handleDrop(c.id); } : undefined}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 transition-colors',
                    dragId === c.id && 'opacity-40',
                    overId === c.id && dragId !== c.id && 'bg-primary/5 ring-1 ring-inset ring-primary/40',
                  )}
                >
                  {canManage && (
                    <div className="mt-0.5 flex shrink-0 flex-col items-center">
                      <span className="cursor-grab text-muted-foreground active:cursor-grabbing" aria-hidden><GripVertical className="h-4 w-4" /></span>
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('acquisition.autoDownload.moveUp', { name: c.name })} className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30">
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={t('acquisition.autoDownload.moveDown', { name: c.name })} className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <span className="mt-0.5 w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">#{c.priorityOrder}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {c.name}
                      {!c.enabled && <Badge variant="secondary">{t('acquisition.status.disabled')}</Badge>}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1 text-xs">
                      {c.qualityRules.resolution && <Badge variant="outline">{c.qualityRules.resolution}</Badge>}
                      {c.qualityRules.codec && <Badge variant="outline">{c.qualityRules.codec}</Badge>}
                      {c.qualityRules.source && <Badge variant="outline">{c.qualityRules.source}</Badge>}
                      {c.sizeRules.maxBytes != null && <Badge variant="outline">≤ {bytesToMb(c.sizeRules.maxBytes)} MB</Badge>}
                      {c.sizeRules.minBytes != null && <Badge variant="outline">≥ {bytesToMb(c.sizeRules.minBytes)} MB</Badge>}
                      {c.excludedTerms.length > 0 && <Badge variant="outline">−{c.excludedTerms.join(' −')}</Badge>}
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => setEditing(c)}>{t('acquisition.common.edit')}</Button>
                      <button type="button" onClick={() => { if (window.confirm(t('acquisition.autoDownload.confirmDelete', { name: c.name }))) removeMutation.mutate(c.id); }} aria-label={t('acquisition.common.deleteName', { name: c.name })} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {showAdd && <CandidateDialog onClose={() => setShowAdd(false)} nextPriority={items.length} />}
      {editing && <CandidateDialog candidate={editing} onClose={() => setEditing(null)} nextPriority={items.length} />}
    </div>
  );
}

const RESOLUTIONS = ['', '2160p', '1080p', '720p', '480p'];
const CODECS = ['', 'x265', 'x264'];
const SOURCES = ['', 'web-dl', 'webrip', 'bluray', 'hdtv'];

function CandidateDialog({ candidate, onClose, nextPriority }: { candidate?: AcquisitionMatchCandidate; onClose: () => void; nextPriority: number }) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const isEdit = Boolean(candidate);

  const [form, setForm] = useState({
    name: candidate?.name ?? '',
    priorityOrder: candidate?.priorityOrder ?? nextPriority,
    enabled: candidate?.enabled ?? true,
    resolution: candidate?.qualityRules.resolution ?? '',
    codec: candidate?.qualityRules.codec ?? '',
    source: candidate?.qualityRules.source ?? '',
    maxMb: bytesToMb(candidate?.sizeRules.maxBytes),
    minMb: bytesToMb(candidate?.sizeRules.minBytes),
    requiredTerms: termsToText(candidate?.requiredTerms ?? []),
    excludedTerms: termsToText(candidate?.excludedTerms ?? []),
  });
  useEffect(() => { /* keep dialog controlled to its candidate */ }, [candidate]);

  const save = useMutation({
    mutationFn: () => {
      const body: MatchCandidateInput = {
        name: form.name.trim(),
        priorityOrder: Number(form.priorityOrder) || 0,
        enabled: form.enabled,
        matchType: 'smart_episode_match',
        requiredTerms: textToTerms(form.requiredTerms),
        excludedTerms: textToTerms(form.excludedTerms),
        qualityRules: {
          ...(form.resolution ? { resolution: form.resolution } : {}),
          ...(form.codec ? { codec: form.codec } : {}),
          ...(form.source ? { source: form.source } : {}),
        },
        sizeRules: {
          ...(mbToBytes(form.maxMb) ? { maxBytes: mbToBytes(form.maxMb) } : {}),
          ...(mbToBytes(form.minMb) ? { minBytes: mbToBytes(form.minMb) } : {}),
        },
      };
      return candidate
        ? api.mediaAcquisition.updateMatchPreference(candidate.id, body)
        : api.mediaAcquisition.createMatchPreference(body);
    },
    onSuccess: () => { toast.success(t('acquisition.autoDownload.toast.saved')); queryClient.invalidateQueries({ queryKey: QK }); onClose(); },
    onError: (e) => toast.error(t('acquisition.autoDownload.toast.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const title = isEdit ? t('acquisition.autoDownload.editTitle') : t('acquisition.autoDownload.addTitle');
  const resOpts = RESOLUTIONS.map((v) => ({ value: v, label: v || t('acquisition.filter.any') }));
  const codecOpts = CODECS.map((v) => ({ value: v, label: v || t('acquisition.filter.any') }));
  const sourceOpts = SOURCES.map((v) => ({ value: v, label: v || t('acquisition.filter.any') }));

  return (
    <Dialog open onClose={onClose} title={title} className="max-w-xl">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t('acquisition.autoDownload.dialogDescription')}</DialogDescription></DialogHeader>
      <form onSubmit={(e) => { e.preventDefault(); if (!form.name.trim()) { toast.error(t('acquisition.autoDownload.nameRequired')); return; } save.mutate(); }} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="mp-name">{t('acquisition.autoDownload.name')}</Label><Input id="mp-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-prio">{t('acquisition.autoDownload.priority')}</Label><Input id="mp-prio" type="number" value={String(form.priorityOrder)} onChange={(e) => setForm((f) => ({ ...f, priorityOrder: Number(e.target.value) }))} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-res">{t('acquisition.autoDownload.resolution')}</Label><Select id="mp-res" value={form.resolution} onChange={(e) => setForm((f) => ({ ...f, resolution: e.target.value }))} options={resOpts} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-codec">{t('acquisition.autoDownload.codec')}</Label><Select id="mp-codec" value={form.codec} onChange={(e) => setForm((f) => ({ ...f, codec: e.target.value }))} options={codecOpts} /></div>
          <div className="space-y-1.5"><Label htmlFor="mp-src">{t('acquisition.autoDownload.source')}</Label><Select id="mp-src" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} options={sourceOpts} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label htmlFor="mp-max">{t('acquisition.autoDownload.maxMb')}</Label><Input id="mp-max" type="number" value={form.maxMb} placeholder="1024" onChange={(e) => setForm((f) => ({ ...f, maxMb: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="mp-min">{t('acquisition.autoDownload.minMb')}</Label><Input id="mp-min" type="number" value={form.minMb} onChange={(e) => setForm((f) => ({ ...f, minMb: e.target.value }))} /></div>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="mp-excl">{t('acquisition.autoDownload.excludedTerms')}</Label><Input id="mp-excl" value={form.excludedTerms} placeholder="x264, cam, hdts" onChange={(e) => setForm((f) => ({ ...f, excludedTerms: e.target.value }))} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="mp-req">{t('acquisition.autoDownload.requiredTerms')}</Label><Input id="mp-req" value={form.requiredTerms} onChange={(e) => setForm((f) => ({ ...f, requiredTerms: e.target.value }))} /></div>
          <div className="flex items-center gap-2 sm:col-span-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} /><span className="text-sm">{t('acquisition.autoDownload.enabled')}</span></div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('acquisition.common.cancel')}</Button>
          <Button type="submit" loading={save.isPending}>{t('acquisition.common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
