import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { CenteredSpinner } from '@/components/ui/feedback';
import { formatBytes } from '@/lib/format';
import { StatusBadge, toNum } from './_shared';

/** The per-file breakdown of a plan — what each file's fate was, and why. */
export function PlanActionsDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { t } = useTranslation('cleanup');
  const { data, isLoading } = useQuery({
    queryKey: ['cleanup', 'plan-actions', planId],
    queryFn: () => api.cleanup.listActions(planId, { pageSize: 200 }),
  });
  const rows = data?.items ?? [];
  return (
    <Dialog open onClose={onClose} title={t('plans.actions.title')} className="max-w-3xl">
      <DialogHeader><DialogTitle>{t('plans.actions.title')}</DialogTitle></DialogHeader>
      {isLoading ? <CenteredSpinner /> : (
        <div className="max-h-[60vh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('plans.actions.col.path')}</TableHead>
                <TableHead>{t('plans.actions.col.status')}</TableHead>
                <TableHead className="text-right">{t('plans.actions.col.size')}</TableHead>
                <TableHead>{t('plans.actions.col.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={a.sourcePath}>{a.sourcePath}</TableCell>
                  <TableCell><StatusBadge status={a.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(toNum(a.fileSizeBytes))}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.skipReason ?? a.errorMessage ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Dialog>
  );
}
