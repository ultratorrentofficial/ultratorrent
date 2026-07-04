import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FolderInput, FolderPlus, Info, Pencil, TriangleAlert } from 'lucide-react';
import { ApiError, api, type FileNode } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';
import { formatBytes, formatDateTime } from '@/lib/format';

/** Shared mutation runner: toast + invalidate + close. */
function useFileMutation() {
  const { t } = useTranslation('files');
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, success: string, onDone?: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      await qc.invalidateQueries({ queryKey: ['files'] });
      onDone?.();
    } catch (err) {
      toast.error(t('toast.operationFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// --- Create folder ---------------------------------------------------------

export function CreateFolderDialog({
  open,
  parentPath,
  onClose,
}: {
  open: boolean;
  parentPath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const [name, setName] = useState('');
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open) setName(''); }, [open]);

  const submit = () =>
    run(() => api.files.createFolder(parentPath, name.trim()), t('createFolder.success', { name: name.trim() }), onClose);

  return (
    <Dialog open={open} onClose={onClose} title={t('createFolder.title')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <FolderPlus className="h-5 w-5" />
        </div>
        <DialogTitle>{t('createFolder.title')}</DialogTitle>
        <DialogDescription>{t('createFolder.description', { path: parentPath })}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="folder-name">{t('createFolder.nameLabel')}</Label>
        <Input
          id="folder-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          placeholder={t('createFolder.namePlaceholder')}
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('createFolder.cancel')}</Button>
        <Button onClick={submit} loading={busy} disabled={!name.trim()}>{t('createFolder.create')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Rename ----------------------------------------------------------------

export function RenameDialog({
  open,
  node,
  onClose,
}: {
  open: boolean;
  node: FileNode | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const [name, setName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open && node) { setName(node.name); setOverwrite(false); } }, [open, node]);

  if (!node) return null;
  const submit = () =>
    run(() => api.files.rename(node.path, name.trim(), overwrite), t('rename.success', { name: name.trim() }), onClose);

  return (
    <Dialog open={open} onClose={onClose} title={t('rename.titleBar')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Pencil className="h-5 w-5" />
        </div>
        <DialogTitle>{node.isDirectory ? t('rename.titleFolder') : t('rename.titleFile')}</DialogTitle>
        <DialogDescription>{t('rename.description', { name: node.name })}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="rename-name">{t('rename.nameLabel')}</Label>
          <Input
            id="rename-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          />
        </div>
        <label className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
          <span className="text-sm">{t('rename.overwriteLabel')}</span>
          <Switch checked={overwrite} onCheckedChange={setOverwrite} aria-label={t('rename.overwriteAria')} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('rename.cancel')}</Button>
        <Button onClick={submit} loading={busy} disabled={!name.trim() || name.trim() === node.name}>{t('rename.submit')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Move / Copy -----------------------------------------------------------

export function MoveCopyDialog({
  open,
  mode,
  paths,
  defaultDestination,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: 'move' | 'copy';
  paths: string[];
  defaultDestination: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation('files');
  const [destination, setDestination] = useState(defaultDestination);
  const [overwrite, setOverwrite] = useState(false);
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open) { setDestination(defaultDestination); setOverwrite(false); } }, [open, defaultDestination]);

  const submit = () =>
    run(
      async () => {
        const dest = destination.trim() || '/';
        if (paths.length === 1) {
          return mode === 'move'
            ? api.files.move(paths[0], dest, overwrite)
            : api.files.copy(paths[0], dest, overwrite);
        }
        return api.files.bulk({ operation: mode, paths, destination: dest, overwrite });
      },
      mode === 'move'
        ? t('moveCopy.moveSuccess', { count: paths.length })
        : t('moveCopy.copySuccess', { count: paths.length }),
      () => { onClose(); onDone?.(); },
    );

  const Icon = mode === 'move' ? FolderInput : Copy;
  return (
    <Dialog open={open} onClose={onClose} title={mode === 'move' ? t('moveCopy.moveTitleBar') : t('moveCopy.copyTitleBar')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <DialogTitle>{mode === 'move' ? t('moveCopy.moveHeading', { count: paths.length }) : t('moveCopy.copyHeading', { count: paths.length })}</DialogTitle>
        <DialogDescription>{t('moveCopy.description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="destination">{t('moveCopy.destinationLabel')}</Label>
          <Input
            id="destination"
            autoFocus
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={t('moveCopy.destinationPlaceholder')}
          />
        </div>
        <label className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
          <span className="text-sm">{t('moveCopy.overwriteLabel')}</span>
          <Switch checked={overwrite} onCheckedChange={setOverwrite} aria-label={t('moveCopy.overwriteAria')} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('moveCopy.cancel')}</Button>
        <Button onClick={submit} loading={busy}>{mode === 'move' ? t('moveCopy.moveAction') : t('moveCopy.copyAction')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Delete ----------------------------------------------------------------

export function DeleteFileDialog({
  open,
  paths,
  name,
  onClose,
  onDone,
}: {
  open: boolean;
  paths: string[];
  name?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation('files');
  const [permanent, setPermanent] = useState(false);
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open) setPermanent(false); }, [open]);

  const submit = () =>
    run(
      async () => {
        if (paths.length === 1) return api.files.remove(paths[0], permanent);
        return api.files.bulk({ operation: 'delete', paths, permanent });
      },
      permanent
        ? t('delete.successPermanent', { count: paths.length })
        : t('delete.successTrash', { count: paths.length }),
      () => { onClose(); onDone?.(); },
    );

  const target =
    paths.length === 1
      ? name
        ? t('delete.targetNamed', { name })
        : t('delete.targetSingle')
      : t('delete.targetMulti', { count: paths.length });
  return (
    <Dialog open={open} onClose={onClose} title={t('delete.titleBar')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <DialogTitle>{t('delete.heading', { count: paths.length })}</DialogTitle>
        <DialogDescription>
          {permanent ? t('delete.descPermanent', { target }) : t('delete.descTrash', { target })}
        </DialogDescription>
      </DialogHeader>
      <label className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">{t('delete.permanentTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('delete.permanentHint')}</p>
        </div>
        <Switch checked={permanent} onCheckedChange={setPermanent} aria-label={t('delete.permanentAria')} />
      </label>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('delete.cancel')}</Button>
        <Button variant="destructive" onClick={submit} loading={busy}>
          {permanent ? t('delete.confirmPermanent') : t('delete.confirmTrash')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Properties ------------------------------------------------------------

export function PropertiesDialog({
  open,
  path,
  onClose,
}: {
  open: boolean;
  path: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const { data, isLoading } = useQuery({
    queryKey: ['file-properties', path],
    queryFn: () => api.files.properties(path as string),
    enabled: open && !!path,
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('properties.titleBar')} className="max-w-lg">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Info className="h-5 w-5" />
        </div>
        <DialogTitle>{t('properties.title')}</DialogTitle>
      </DialogHeader>
      {isLoading || !data ? (
        <CenteredSpinner label={t('properties.loading')} />
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 text-sm">
          <Row label={t('properties.name')} value={data.name} />
          <Row label={t('properties.type')} value={data.isDirectory ? t('properties.folder') : t('properties.file')} />
          <Row label={t('properties.path')} value={data.path} mono />
          <Row label={t('properties.fullPath')} value={data.absolutePath} mono />
          <Row label={t('properties.size')} value={formatBytes(data.size)} />
          {data.isDirectory && data.itemCount !== undefined && (
            <Row label={t('properties.items')} value={String(data.itemCount)} />
          )}
          {data.extension && <Row label={t('properties.extension')} value={data.extension} />}
          <Row label={t('properties.created')} value={formatDateTime(data.createdAt)} />
          <Row label={t('properties.modified')} value={formatDateTime(data.modifiedAt)} />
          {data.hash && <Row label={t('properties.hash')} value={data.hash} mono />}
          {data.media && (
            <Row label={t('properties.media')} value={JSON.stringify(data.media)} mono />
          )}
        </dl>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('properties.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Preview ---------------------------------------------------------------

export function PreviewDialog({
  open,
  node,
  canDownload,
  onClose,
}: {
  open: boolean;
  node: FileNode | null;
  canDownload: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const toast = useToast();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['file-preview', node?.path],
    queryFn: () => api.files.preview(node!.path),
    enabled: open && !!node,
    retry: false,
  });

  const download = async () => {
    if (!node) return;
    try {
      await api.files.download(node.path);
    } catch (err) {
      toast.error(t('toast.downloadFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  if (!node) return null;
  return (
    <Dialog open={open} onClose={onClose} title={t('preview.titleBar')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle className="truncate">{node.name}</DialogTitle>
        <DialogDescription>{formatBytes(node.size)}</DialogDescription>
      </DialogHeader>
      {isLoading ? (
        <CenteredSpinner label={t('preview.loading')} />
      ) : isError ? (
        <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          {(error as ApiError)?.message ?? t('preview.cannotPreview')}
        </div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto scrollbar-thin rounded-lg border border-border/60 bg-black/30 p-3 text-xs leading-relaxed">
          {data?.content}
        </pre>
      )}
      <DialogFooter>
        {canDownload && <Button variant="secondary" onClick={download}>{t('preview.download')}</Button>}
        <Button variant="ghost" onClick={onClose}>{t('preview.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate break-all font-mono text-xs' : 'truncate'} title={value}>{value}</dd>
    </>
  );
}
