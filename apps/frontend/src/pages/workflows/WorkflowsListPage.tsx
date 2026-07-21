import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import type { WorkflowStatus } from './types';

const PAGE_SIZE = 25;

const STATUS_VARIANT: Record<WorkflowStatus, BadgeVariant> = {
  draft: 'secondary',
  validation_failed: 'destructive',
  ready: 'default',
  published: 'success',
  disabled: 'warning',
  archived: 'secondary',
};

/** The Workflows landing surface — searchable, paginated list + create dialog. */
export function WorkflowsListPage() {
  const { t } = useTranslation('workflows');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const canCreate = hasPermission(PERMISSIONS.WORKFLOWS_CREATE);

  const query = useQuery({
    queryKey: ['workflows', page, search],
    queryFn: () => api.workflows.list({ page, pageSize: PAGE_SIZE, search: search || undefined }),
    placeholderData: keepPreviousData,
  });

  const createMut = useMutation({
    mutationFn: () => api.workflows.create({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (wf) => {
      toast.success(t('toast.created'));
      setCreateOpen(false);
      setName('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflows/${wf.id}`);
    },
    onError: () => toast.error(t('toast.error')),
  });

  if (query.isLoading) return <CenteredSpinner label={t('title')} />;
  if (query.isError) return <ErrorState title={t('toast.error')} onRetry={() => query.refetch()} />;

  const data = query.data;
  const items = data?.items ?? [];

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> {t('list.new')}
          </Button>
        )}
      </div>

      <Input
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        placeholder={t('list.search')}
        className="max-w-sm"
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon className="h-8 w-8" />}
          title={t('list.empty')}
          description={t('list.emptyHint')}
          action={canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" />{t('list.new')}</Button> : undefined}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('list.columns.name')}</TableHead>
                  <TableHead>{t('list.columns.status')}</TableHead>
                  <TableHead>{t('list.columns.updated')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((wf) => (
                  <TableRow key={wf.id}>
                    <TableCell>
                      <Link to={`/workflows/${wf.id}`} className="font-medium hover:underline">{wf.name}</Link>
                      {wf.description && <div className="text-xs text-muted-foreground">{wf.description}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[wf.status]}>{t(`status.${wf.status}`)}</Badge>
                        {wf.enabled && <Badge variant="success" dot>{t('list.enabled')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(wf.updatedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => navigate(`/workflows/${wf.id}`)}>
                        {t('list.open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} busy={query.isFetching} />
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('create.title')}>
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t('create.name')}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('create.namePlaceholder')} autoFocus />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t('create.description')}</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('create.descriptionPlaceholder')} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('create.cancel')}</Button>
          <Button disabled={!name.trim() || createMut.isPending} onClick={() => createMut.mutate()}>
            {t('create.submit')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
