import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileCog, Plus, LayoutTemplate } from 'lucide-react';
import { api, ApiError, type CleanupPolicy } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { usePermission } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import { CleanupHeader, StatusBadge } from './_shared';
import { PolicyDraftDialog } from './PolicyDraftDialog';

export function CleanupPoliciesPage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const canCreate = usePermission(PERMISSIONS.LIBRARY_CLEANUP_POLICY_CREATE);
  const canPublish = usePermission(PERMISSIONS.LIBRARY_CLEANUP_POLICY_PUBLISH);
  const canEnable = usePermission(PERMISSIONS.LIBRARY_CLEANUP_POLICY_ENABLE);
  const canDelete = usePermission(PERMISSIONS.LIBRARY_CLEANUP_POLICY_DELETE);
  const canRun = usePermission(PERMISSIONS.LIBRARY_CLEANUP_RUN);
  const canSimulate = usePermission(PERMISSIONS.LIBRARY_CLEANUP_SIMULATE);
  const canEdit = usePermission(PERMISSIONS.LIBRARY_CLEANUP_POLICY_EDIT);

  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [draftPolicyId, setDraftPolicyId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cleanup', 'policies', 'list'],
    queryFn: () => api.cleanup.listPolicies({ pageSize: 200 }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cleanup', 'policies'] });
  const onErr = (e: unknown) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined);
  const lifecycleOpts = { onSuccess: () => invalidate(), onError: onErr };

  const publish = useMutation({ mutationFn: (id: string) => api.cleanup.publishPolicy(id), ...lifecycleOpts });
  const enable = useMutation({ mutationFn: (id: string) => api.cleanup.enablePolicy(id), ...lifecycleOpts });
  const disable = useMutation({ mutationFn: (id: string) => api.cleanup.disablePolicy(id), ...lifecycleOpts });
  const archive = useMutation({ mutationFn: (id: string) => api.cleanup.archivePolicy(id), ...lifecycleOpts });
  const remove = useMutation({ mutationFn: (id: string) => api.cleanup.deletePolicy(id), ...lifecycleOpts });
  const simulate = useMutation({
    mutationFn: (id: string) => api.cleanup.simulate(id),
    onSuccess: (run) => { toast.success(t('policies.action.simulate'), run.id); qc.invalidateQueries({ queryKey: ['cleanup', 'runs'] }); },
    onError: onErr,
  });
  const run = useMutation({
    mutationFn: (id: string) => api.cleanup.run(id),
    onSuccess: (r) => { toast.success(t('policies.action.run'), r.id); qc.invalidateQueries({ queryKey: ['cleanup', 'runs'] }); },
    onError: onErr,
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('common.loadError')} onRetry={() => refetch()} />;

  const rows = data?.items ?? [];

  const header = (
    <CleanupHeader
      title={t('policies.title')}
      subtitle={t('policies.subtitle')}
      actions={canCreate ? (
        <>
          <Button variant="outline" onClick={() => setTemplateOpen(true)}>
            <LayoutTemplate className="h-4 w-4" /> {t('policies.fromTemplate')}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> {t('policies.new')}
          </Button>
        </>
      ) : undefined}
    />
  );

  return (
    <div className="space-y-4">
      {header}

      {rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState
            icon={<FileCog className="h-6 w-6" />}
            title={t('policies.empty')}
            description={t('policies.emptyDesc')}
          />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('policies.col.name')}</TableHead>
                <TableHead>{t('policies.col.mode')}</TableHead>
                <TableHead>{t('policies.col.status')}</TableHead>
                <TableHead>{t('policies.col.enabled')}</TableHead>
                <TableHead>{t('policies.col.lastRun')}</TableHead>
                <TableHead className="text-right">{t('policies.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <PolicyRow
                  key={p.id} p={p}
                  perms={{ canPublish, canEnable, canDelete, canRun, canSimulate, canEdit }}
                  onPublish={() => publish.mutate(p.id)}
                  onEnable={() => { if (window.confirm(t('policies.confirmEnable'))) enable.mutate(p.id); }}
                  onDisable={() => disable.mutate(p.id)}
                  onArchive={() => archive.mutate(p.id)}
                  onDelete={() => { if (window.confirm(t('policies.confirmDelete'))) remove.mutate(p.id); }}
                  onSimulate={() => simulate.mutate(p.id)}
                  onRun={() => { if (!p.publishedVersionId) { toast.error(t('policies.publishFirst')); return; } run.mutate(p.id); }}
                  onEditDraft={() => setDraftPolicyId(p.id)}
                  busy={publish.isPending || enable.isPending || disable.isPending || run.isPending || simulate.isPending}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      {createOpen && <CreatePolicyDialog onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); invalidate(); }} />}
      {templateOpen && <TemplateDialog onClose={() => setTemplateOpen(false)} onCreated={() => { setTemplateOpen(false); invalidate(); }} />}
      {draftPolicyId && <PolicyDraftDialog policyId={draftPolicyId} onClose={() => setDraftPolicyId(null)} onSaved={invalidate} />}
    </div>
  );
}

function PolicyRow({
  p, perms, onPublish, onEnable, onDisable, onArchive, onDelete, onSimulate, onRun, onEditDraft, busy,
}: {
  p: CleanupPolicy;
  perms: Record<'canPublish' | 'canEnable' | 'canDelete' | 'canRun' | 'canSimulate' | 'canEdit', boolean>;
  onPublish: () => void; onEnable: () => void; onDisable: () => void; onArchive: () => void;
  onDelete: () => void; onSimulate: () => void; onRun: () => void; onEditDraft: () => void; busy: boolean;
}) {
  const { t } = useTranslation('cleanup');
  const hasDraft = !!p.currentDraftVersionId;
  // A template seeds the description with its i18n key; resolve those so a row does
  // not display a raw `cleanup.template.*` string. A user-typed description passes through.
  const description = p.description?.startsWith('cleanup.')
    ? t(p.description.replace(/^cleanup\./, '') as 'template.oldUnwatchedLowRes.desc')
    : p.description;
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium text-foreground">{p.name}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </TableCell>
      <TableCell className="text-sm">{t(`mode.${p.mode}`, { defaultValue: p.mode })}</TableCell>
      <TableCell><StatusBadge status={p.status} /></TableCell>
      <TableCell>{p.enabled ? <StatusBadge status="published" /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{p.lastRunAt ? formatRelativeTime(p.lastRunAt) : '—'}</TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1.5">
          {perms.canEdit && hasDraft && (
            <Button size="sm" variant="ghost" onClick={onEditDraft}>{t('policies.action.editDraft')}</Button>
          )}
          {perms.canSimulate && (
            <Button size="sm" variant="ghost" onClick={onSimulate} disabled={busy}>{t('policies.action.simulate')}</Button>
          )}
          {perms.canPublish && hasDraft && (
            <Button size="sm" variant="secondary" onClick={onPublish} disabled={busy}>{t('policies.action.publish')}</Button>
          )}
          {perms.canRun && p.publishedVersionId && (
            <Button size="sm" variant="secondary" onClick={onRun} disabled={busy}>{t('policies.action.run')}</Button>
          )}
          {perms.canEnable && p.publishedVersionId && (
            p.enabled
              ? <Button size="sm" variant="ghost" onClick={onDisable} disabled={busy}>{t('policies.action.disable')}</Button>
              : <Button size="sm" variant="ghost" onClick={onEnable} disabled={busy}>{t('policies.action.enable')}</Button>
          )}
          {perms.canDelete && p.status !== 'archived' && (
            <Button size="sm" variant="ghost" onClick={onArchive}>{t('policies.action.archive')}</Button>
          )}
          {perms.canDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete}>{t('policies.action.delete')}</Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreatePolicyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.cleanup.createPolicy({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: onCreated,
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });
  return (
    <Dialog open onClose={onClose} title={t('policies.create.title')}>
      <DialogHeader><DialogTitle>{t('policies.create.title')}</DialogTitle></DialogHeader>
      <div className="space-y-3 py-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('policies.create.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('policies.create.description')}</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
          {t('policies.create.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function TemplateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const templates = useQuery({ queryKey: ['cleanup', 'templates'], queryFn: () => api.cleanup.templates() });
  const [templateKey, setTemplateKey] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.cleanup.createFromTemplate({ templateKey, name: name.trim() }),
    onSuccess: onCreated,
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });
  // The backend hands us namespace-qualified i18n keys (`cleanup.template.*`);
  // strip the leading namespace so `t` resolves them within this namespace.
  const tk = (key: string | undefined) => key ? t(key.replace(/^cleanup\./, '') as 'template.oldUnwatchedLowRes.name') : '';
  const chosen = templates.data?.find((tp) => tp.key === templateKey);
  return (
    <Dialog open onClose={onClose} title={t('policies.create.templateTitle')}>
      <DialogHeader>
        <DialogTitle>{t('policies.create.templateTitle')}</DialogTitle>
        {chosen && <DialogDescription>{tk(chosen.descriptionKey)}</DialogDescription>}
      </DialogHeader>
      <div className="space-y-3 py-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('policies.create.template')}</span>
          <Select
            value={templateKey}
            onChange={(e) => { const tp = templates.data?.find((x) => x.key === e.target.value); setTemplateKey(e.target.value); if (!name && tp) setName(tk(tp.nameKey)); }}
            options={[{ value: '', label: '—' }, ...(templates.data ?? []).map((tp) => ({ value: tp.key, label: tk(tp.nameKey) }))]}
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('policies.create.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!templateKey || !name.trim()}>
          {t('policies.create.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
