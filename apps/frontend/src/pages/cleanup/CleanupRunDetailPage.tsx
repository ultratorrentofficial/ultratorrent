import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck } from 'lucide-react';
import { api, ApiError, type CleanupCandidate } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { usePermission } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatBytes } from '@/lib/format';
import { CleanupHeader, StatusBadge, toNum } from './_shared';

export function CleanupRunDetailPage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { runId = '' } = useParams();
  const canPlan = usePermission(PERMISSIONS.LIBRARY_CLEANUP_RUN);

  const [tab, setTab] = useState<'candidate' | 'excluded'>('candidate');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // The candidate list serves 'candidate' rows or, for the excluded view, we ask
  // the API for a specific excluded status. The eligible set is what can be planned.
  const query = useQuery({
    queryKey: ['cleanup', 'candidates', runId, tab, page],
    queryFn: () => api.cleanup.listCandidates(runId, { page, pageSize: 50, status: tab === 'candidate' ? 'candidate' : 'excluded_protected' }),
    placeholderData: keepPreviousData,
  });

  const createPlan = useMutation({
    mutationFn: () => api.cleanup.createPlan(runId, { candidateIds: [...selected] }),
    onSuccess: (plan) => {
      toast.success(t('plans.title'), plan.id);
      qc.invalidateQueries({ queryKey: ['cleanup', 'plans'] });
      navigate('/media/cleanup/plans');
    },
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const rows = query.data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  };
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectedBytes = useMemo(
    () => rows.filter((r) => selected.has(r.id)).reduce((n, r) => n + toNum(r.estimatedReclaimBytes), 0),
    [rows, selected],
  );

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('/media/cleanup/runs')} className="w-fit">
        <ArrowLeft className="h-4 w-4" /> {t('runs.title')}
      </Button>

      <CleanupHeader
        title={t('runs.candidates.title')}
        subtitle={t('runs.subtitle')}
        actions={canPlan && tab === 'candidate' && selected.size > 0 ? (
          <Button onClick={() => createPlan.mutate()} loading={createPlan.isPending}>
            <ClipboardCheck className="h-4 w-4" />
            {t('runs.candidates.buildPlan')} · {formatBytes(selectedBytes)}
          </Button>
        ) : undefined}
      />

      <Tabs value={tab} onValueChange={(v) => { setTab(v as 'candidate' | 'excluded'); setPage(1); setSelected(new Set()); }}>
        <TabsList>
          <TabsTrigger value="candidate">{t('runs.candidates.eligibleOnly')}</TabsTrigger>
          <TabsTrigger value="excluded">{t('runs.candidates.excludedOnly')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {query.isLoading ? <CenteredSpinner /> : query.isError ? (
        <ErrorState message={t('common.loadError')} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title={t('runs.candidates.empty')} />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {tab === 'candidate' && (
                  <TableHead className="w-8">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="select all" />
                  </TableHead>
                )}
                <TableHead>{t('runs.candidates.col.path')}</TableHead>
                <TableHead className="text-right">{t('runs.candidates.col.size')}</TableHead>
                <TableHead>{tab === 'candidate' ? t('runs.candidates.col.rank') : t('runs.candidates.col.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <CandidateRow key={c.id} c={c} selectable={tab === 'candidate'} checked={selected.has(c.id)} onToggle={() => toggle(c.id)} />
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      {selected.size > 0 && (
        <div className="text-sm text-muted-foreground">{t('runs.candidates.selected', { count: selected.size })}</div>
      )}
      <Pagination page={page} pageSize={50} total={query.data?.total ?? 0} onPage={setPage} />
    </div>
  );
}

function CandidateRow({
  c, selectable, checked, onToggle,
}: { c: CleanupCandidate; selectable: boolean; checked: boolean; onToggle: () => void }) {
  const topReason = c.rankReasons?.[0]?.detail;
  return (
    <TableRow>
      {selectable && (
        <TableCell><Checkbox checked={checked} onCheckedChange={onToggle} aria-label="select" /></TableCell>
      )}
      <TableCell className="max-w-md truncate font-mono text-xs" title={c.path}>{c.path}</TableCell>
      <TableCell className="text-right tabular-nums">{formatBytes(toNum(c.fileSizeBytes))}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {selectable
          ? (c.rankScore != null ? <span title={topReason}>{Math.round(c.rankScore)}{topReason ? ` · ${topReason}` : ''}</span> : '—')
          : <StatusBadge status={c.exclusionReason ?? c.status} />}
      </TableCell>
    </TableRow>
  );
}
