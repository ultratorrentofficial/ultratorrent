import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Plus, AlertTriangle } from 'lucide-react';
import { api, ApiError, type CleanupCreateProtection } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { usePermission } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import { CleanupHeader } from './_shared';

const TARGET_TYPES = ['media_file', 'media_item', 'show', 'season', 'episode', 'library', 'path_prefix', 'tag', 'collection', 'watchlist', 'torrent', 'external_identity'];
const PROTECTION_TYPES = ['permanent', 'temporary', 'conditional', 'legal_hold'];

export function CleanupProtectionsPage() {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const qc = useQueryClient();
  const canCreate = usePermission(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_CREATE);
  const canRevoke = usePermission(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_REVOKE);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cleanup', 'protections', 'list', page],
    queryFn: () => api.cleanup.listProtections({ page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  const expiring = useQuery({ queryKey: ['cleanup', 'protections', 'expiring'], queryFn: () => api.cleanup.expiringProtections(14) });

  const revoke = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.cleanup.revokeProtection(v.id, v.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cleanup', 'protections'] }),
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('common.loadError')} onRetry={() => refetch()} />;

  const rows = data?.items ?? [];
  const expiringCount = expiring.data?.length ?? 0;

  const describeTarget = (p: (typeof rows)[number]) =>
    p.pathPrefix || p.mediaLibraryId || p.mediaItemId || p.mediaFileId || t(`protections.create.targetType`);

  return (
    <div className="space-y-4">
      <CleanupHeader
        title={t('protections.title')}
        subtitle={t('protections.subtitle')}
        actions={canCreate ? (
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> {t('protections.new')}</Button>
        ) : undefined}
      />

      {expiringCount > 0 && (
        <Card><CardContent className="flex items-center gap-2 py-3 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" />
          {t('protections.expiringSoon', { count: expiringCount })}
        </CardContent></Card>
      )}

      {rows.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title={t('protections.empty')} description={t('protections.emptyDesc')} />
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('protections.col.target')}</TableHead>
                <TableHead>{t('protections.col.type')}</TableHead>
                <TableHead>{t('protections.col.reason')}</TableHead>
                <TableHead>{t('protections.col.expires')}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-sm">
                    <div className="font-mono text-xs">{describeTarget(p)}</div>
                    <div className="text-xs text-muted-foreground">{p.targetType}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.protectionType === 'legal_hold' ? 'destructive' : 'secondary'}>{p.protectionType}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={p.reason}>{p.reason}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.protectedUntil ? formatRelativeTime(p.protectedUntil) : '—'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      {canRevoke && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => { const reason = window.prompt(t('protections.revokeReason')); if (reason) revoke.mutate({ id: p.id, reason }); }}
                        >
                          {t('protections.revoke')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} />
      {createOpen && <CreateProtectionDialog onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ['cleanup', 'protections'] }); }} />}
    </div>
  );
}

function CreateProtectionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('cleanup');
  const toast = useToast();
  const canLegalHold = usePermission(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_LEGAL_HOLD);
  const [targetType, setTargetType] = useState('library');
  const [protectionType, setProtectionType] = useState('permanent');
  const [reason, setReason] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [until, setUntil] = useState('');

  const usesPath = targetType === 'path_prefix';
  const usesLibrary = targetType === 'library';

  // A legal hold cannot be placed without its own permission; hide the option so the
  // form never offers what the server will refuse.
  const protectionOptions = PROTECTION_TYPES.filter((p) => p !== 'legal_hold' || canLegalHold);

  const create = useMutation({
    mutationFn: () => {
      const body: CleanupCreateProtection = { targetType, protectionType, reason: reason.trim() };
      if (usesPath) body.pathPrefix = targetValue.trim();
      else if (usesLibrary) body.mediaLibraryId = targetValue.trim();
      else body.mediaItemId = targetValue.trim();
      if (protectionType === 'temporary' && until) body.protectedUntil = new Date(until).toISOString();
      return api.cleanup.createProtection(body);
    },
    onSuccess: onCreated,
    onError: (e) => toast.error(t('common.actionFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const targetLabel = usesPath ? t('protections.create.pathPrefix') : usesLibrary ? t('protections.create.libraryId') : t('protections.create.mediaItemId');

  return (
    <Dialog open onClose={onClose} title={t('protections.create.title')}>
      <DialogHeader><DialogTitle>{t('protections.create.title')}</DialogTitle></DialogHeader>
      <div className="space-y-3 py-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('protections.create.targetType')}</span>
          <Select value={targetType} onChange={(e) => setTargetType(e.target.value)}
            options={TARGET_TYPES.map((v) => ({ value: v, label: v }))} />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">{targetLabel}</span>
          <Input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('protections.create.protectionType')}</span>
          <Select value={protectionType} onChange={(e) => setProtectionType(e.target.value)}
            options={protectionOptions.map((v) => ({ value: v, label: v }))} />
        </label>
        {protectionType === 'temporary' && (
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('protections.create.protectedUntil')}</span>
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('protections.create.reason')}</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('protections.create.reasonPlaceholder')} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!reason.trim() || !targetValue.trim()}>
          {t('protections.create.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
