import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api, ApiError, type CleanupValidation } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';

/**
 * The draft editor.
 *
 * A policy is a JSON document evaluated by the platform's constrained engine —
 * there is genuinely nothing executable in it — so a raw, validated document editor
 * is a faithful (if unglamorous) representation. A full visual condition builder is
 * a substantial surface of its own and is deliberately deferred; this is honest
 * about that in its help text rather than pretending to be one.
 */
export function PolicyDraftDialog({
  policyId, onClose, onSaved,
}: { policyId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<CleanupValidation | null>(null);

  const detail = useQuery({ queryKey: ['cleanup', 'policy', policyId], queryFn: () => api.cleanup.getPolicy(policyId) });

  useEffect(() => {
    if (!detail.data) return;
    const doc = detail.data.draftVersion?.document ?? detail.data.publishedVersion?.document ?? {};
    setText(JSON.stringify(doc, null, 2));
  }, [detail.data]);

  const parsed = (): unknown | undefined => {
    try {
      const v = JSON.parse(text);
      setParseError(null);
      return v;
    } catch (e) {
      setParseError((e as Error).message);
      return undefined;
    }
  };

  const validate = useMutation({
    mutationFn: async () => {
      const doc = parsed();
      if (doc === undefined) throw new Error('invalid json');
      return api.cleanup.validate(doc);
    },
    onSuccess: setValidation,
    onError: (e) => { if (e instanceof ApiError) toast.error(t('common.actionFailed'), e.message); },
  });

  const save = useMutation({
    mutationFn: async () => {
      const doc = parsed();
      if (doc === undefined) throw new Error('invalid json');
      return api.cleanup.saveDraft(policyId, doc);
    },
    onSuccess: () => { toast.success(t('policies.draft.save')); onSaved(); onClose(); },
    onError: (e) => { if (e instanceof ApiError) toast.error(t('common.actionFailed'), e.message); },
  });

  return (
    <Dialog open onClose={onClose} title={t('policies.draft.title')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('policies.draft.title')}</DialogTitle>
        <DialogDescription>{t('policies.draft.help')}</DialogDescription>
      </DialogHeader>

      {detail.isLoading ? <CenteredSpinner /> : (
        <div className="space-y-3 py-2">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setValidation(null); setParseError(null); }}
            spellCheck={false}
            className="h-80 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-foreground focus:border-info/50 focus:outline-none"
          />
          {parseError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" /> {parseError}
            </div>
          )}
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
