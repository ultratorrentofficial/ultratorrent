import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api, ApiError, type CleanupValidation } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';
import { ConditionBuilder, isGroup, type ConditionGroup } from './ConditionBuilder';

/**
 * The draft editor.
 *
 * It used to be a raw JSON textarea, and the comment here said a visual builder
 * was "deliberately deferred". The cost of that deferral was that configuring a
 * policy meant knowing a 63-entry condition catalogue by heart and hand-writing
 * a document — which is exactly why policies were reported as extremely hard to
 * understand, configure and use.
 *
 * What the editor now guarantees:
 *
 *  - **No JSON reaches the user.** Conditions are picked from a labelled,
 *    described catalogue; the action is chosen from explained modes.
 *  - **Nothing is silently dropped.** Parts a builder cannot yet represent —
 *    `scope`, `replacement`, `storagePressure`, nested condition groups — are
 *    carried through untouched rather than rewritten. An editor that quietly
 *    simplifies a document it did not understand would be worse than a textarea.
 *  - **The dangerous choice is explained where it is made.** The mode is the
 *    difference between a report and an unattended deletion, so it says so at
 *    the point of selection rather than in documentation nobody opens.
 */

type Mode = 'report_only' | 'approval_required' | 'auto_quarantine' | 'auto_trash';

const MODE_ORDER: Mode[] = ['report_only', 'approval_required', 'auto_quarantine', 'auto_trash'];

export function PolicyDraftDialog({
  policyId, onClose, onSaved,
}: { policyId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [validation, setValidation] = useState<CleanupValidation | null>(null);

  const detail = useQuery({ queryKey: ['cleanup', 'policy', policyId], queryFn: () => api.cleanup.getPolicy(policyId) });
  const catalog = useQuery({ queryKey: ['cleanup', 'conditions'], queryFn: () => api.cleanup.catalog() });

  useEffect(() => {
    if (!detail.data) return;
    const d = (detail.data.draftVersion?.document ?? detail.data.publishedVersion?.document ?? {}) as Record<string, unknown>;
    setDoc(d);
  }, [detail.data]);

  const conditions = (doc?.conditions as ConditionGroup | undefined) ?? { type: 'all', children: [] };
  const action = (doc?.action ?? {}) as { mode?: Mode; destination?: string; retentionDays?: number };

  const patch = (next: Partial<Record<string, unknown>>) => {
    setDoc((prev) => ({ ...(prev ?? {}), ...next }));
    setValidation(null);
  };

  const validate = useMutation({
    mutationFn: async () => api.cleanup.validate(doc ?? {}),
    onSuccess: setValidation,
    onError: (e) => { if (e instanceof ApiError) toast.error(t('common.actionFailed'), e.message); },
  });

  const save = useMutation({
    mutationFn: async () => api.cleanup.saveDraft(policyId, doc ?? {}),
    onSuccess: () => { toast.success(t('policies.draft.save')); onSaved(); onClose(); },
    onError: (e) => { if (e instanceof ApiError) toast.error(t('common.actionFailed'), e.message); },
  });

  const loading = detail.isLoading || catalog.isLoading || !doc;

  return (
    <Dialog open onClose={onClose} title={t('policies.draft.title')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('policies.draft.title')}</DialogTitle>
        <DialogDescription>{t('policies.draft.help')}</DialogDescription>
      </DialogHeader>

      {loading ? <CenteredSpinner /> : (
        <div className="max-h-[60vh] space-y-5 overflow-y-auto py-2">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('builder.conditionsTitle')}</h3>
            <ConditionBuilder
              node={conditions}
              catalog={catalog.data?.conditions ?? []}
              onChange={(next) => patch({ conditions: next })}
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('builder.actionTitle')}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={action.mode ?? 'report_only'}
                onChange={(e) => patch({ action: { ...action, mode: e.target.value as Mode } })}
                className="w-auto"
              >
                {MODE_ORDER.map((m) => (
                  <option key={m} value={m}>{t(`builder.mode.${m}` as 'builder.mode.report_only')}</option>
                ))}
              </Select>
              <Select
                value={action.destination ?? 'trash'}
                onChange={(e) => patch({ action: { ...action, destination: e.target.value } })}
                className="w-auto"
              >
                <option value="quarantine">{t('builder.dest.quarantine')}</option>
                <option value="trash">{t('builder.dest.trash')}</option>
              </Select>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                {t('builder.retention')}
                <Input
                  type="number"
                  className="w-24"
                  value={action.retentionDays ?? ''}
                  onChange={(e) => patch({
                    action: { ...action, retentionDays: e.target.value === '' ? undefined : Number(e.target.value) },
                  })}
                />
              </label>
            </div>
            {/* The mode is the difference between a report and an unattended
                deletion, so it explains itself where it is chosen. */}
            <p className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground">
              {t(`builder.modeHelp.${action.mode ?? 'report_only'}` as 'builder.modeHelp.report_only')}
            </p>
          </section>

          {/* Anything the builder cannot represent is preserved, and said so out
              loud — a silent rewrite would be worse than the textarea it replaced. */}
          {(doc?.replacement || doc?.storagePressure || conditions.children.some(isGroup)) ? (
            <p className="text-xs text-muted-foreground">{t('builder.preserved')}</p>
          ) : null}

          {validation && (
            <div className="space-y-1 text-sm">
              {validation.valid
                ? <div className="flex items-center gap-2 text-success"><CheckCircle2 className="h-4 w-4" /> {t('policies.draft.valid')}</div>
                : <div className="flex items-center gap-2 text-destructive"><XCircle className="h-4 w-4" /> {t('policies.draft.invalid')}</div>}
              {validation.errors.map((er, i) => (
                <div key={i} className="pl-6 text-destructive">{er.path ? `${er.path}: ` : ''}{er.message}</div>
              ))}
              {validation.warnings.length > 0 && (
                <div className="pl-6 text-warning">
                  <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {t('policies.draft.warnings')}</div>
                  {validation.warnings.map((w, i) => <div key={i} className="pl-6">{w.path ? `${w.path}: ` : ''}{w.message}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="outline" onClick={() => validate.mutate()} loading={validate.isPending}>{t('policies.draft.validate')}</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending}>{t('policies.draft.save')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
