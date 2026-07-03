import { useEffect, useState } from 'react';
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
import { formatBytes, formatDateTime, pluralize } from '@/lib/format';

/** Shared mutation runner: toast + invalidate + close. */
function useFileMutation() {
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
      toast.error('Operation failed', err instanceof ApiError ? err.message : undefined);
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
  const [name, setName] = useState('');
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open) setName(''); }, [open]);

  const submit = () =>
    run(() => api.files.createFolder(parentPath, name.trim()), `Created “${name.trim()}”`, onClose);

  return (
    <Dialog open={open} onClose={onClose} title="New folder" className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <FolderPlus className="h-5 w-5" />
        </div>
        <DialogTitle>New folder</DialogTitle>
        <DialogDescription>Create a folder in {parentPath}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="folder-name">Folder name</Label>
        <Input
          id="folder-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          placeholder="Season 01"
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy} disabled={!name.trim()}>Create</Button>
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
  const [name, setName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open && node) { setName(node.name); setOverwrite(false); } }, [open, node]);

  if (!node) return null;
  const submit = () =>
    run(() => api.files.rename(node.path, name.trim(), overwrite), `Renamed to “${name.trim()}”`, onClose);

  return (
    <Dialog open={open} onClose={onClose} title="Rename" className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Pencil className="h-5 w-5" />
        </div>
        <DialogTitle>Rename {node.isDirectory ? 'folder' : 'file'}</DialogTitle>
        <DialogDescription>Renaming “{node.name}”</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="rename-name">New name</Label>
          <Input
            id="rename-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          />
        </div>
        <label className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
          <span className="text-sm">Overwrite if it exists</span>
          <Switch checked={overwrite} onCheckedChange={setOverwrite} aria-label="Overwrite" />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy} disabled={!name.trim() || name.trim() === node.name}>Rename</Button>
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
      `${mode === 'move' ? 'Moved' : 'Copied'} ${pluralize(paths.length, 'item')}`,
      () => { onClose(); onDone?.(); },
    );

  const Icon = mode === 'move' ? FolderInput : Copy;
  return (
    <Dialog open={open} onClose={onClose} title={mode === 'move' ? 'Move' : 'Copy'} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <DialogTitle>{mode === 'move' ? 'Move' : 'Copy'} {pluralize(paths.length, 'item')}</DialogTitle>
        <DialogDescription>Choose a destination folder (root-relative).</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="destination">Destination folder</Label>
          <Input
            id="destination"
            autoFocus
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="/movies"
          />
        </div>
        <label className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
          <span className="text-sm">Overwrite existing</span>
          <Switch checked={overwrite} onCheckedChange={setOverwrite} aria-label="Overwrite" />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy}>{mode === 'move' ? 'Move' : 'Copy'}</Button>
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
  const [permanent, setPermanent] = useState(false);
  const { busy, run } = useFileMutation();
  useEffect(() => { if (open) setPermanent(false); }, [open]);

  const submit = () =>
    run(
      async () => {
        if (paths.length === 1) return api.files.remove(paths[0], permanent);
        return api.files.bulk({ operation: 'delete', paths, permanent });
      },
      permanent ? `Permanently deleted ${pluralize(paths.length, 'item')}` : `Moved ${pluralize(paths.length, 'item')} to Trash`,
      () => { onClose(); onDone?.(); },
    );

  const target = paths.length === 1 ? (name ? `“${name}”` : 'this item') : `${paths.length} items`;
  return (
    <Dialog open={open} onClose={onClose} title="Delete" className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <DialogTitle>Delete {paths.length === 1 ? 'item' : `${paths.length} items`}?</DialogTitle>
        <DialogDescription>
          {permanent
            ? `${target} will be permanently removed from disk. This cannot be undone.`
            : `${target} will be moved to Trash and can be restored later.`}
        </DialogDescription>
      </DialogHeader>
      <label className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Delete permanently</p>
          <p className="text-xs text-muted-foreground">Skip Trash and remove from disk now.</p>
        </div>
        <Switch checked={permanent} onCheckedChange={setPermanent} aria-label="Permanent delete" />
      </label>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="destructive" onClick={submit} loading={busy}>
          {permanent ? 'Delete permanently' : 'Move to Trash'}
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
  const { data, isLoading } = useQuery({
    queryKey: ['file-properties', path],
    queryFn: () => api.files.properties(path as string),
    enabled: open && !!path,
  });

  return (
    <Dialog open={open} onClose={onClose} title="Properties" className="max-w-lg">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Info className="h-5 w-5" />
        </div>
        <DialogTitle>Properties</DialogTitle>
      </DialogHeader>
      {isLoading || !data ? (
        <CenteredSpinner label="Reading…" />
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 text-sm">
          <Row label="Name" value={data.name} />
          <Row label="Type" value={data.isDirectory ? 'Folder' : 'File'} />
          <Row label="Path" value={data.path} mono />
          <Row label="Full path" value={data.absolutePath} mono />
          <Row label="Size" value={formatBytes(data.size)} />
          {data.isDirectory && data.itemCount !== undefined && (
            <Row label="Items" value={String(data.itemCount)} />
          )}
          {data.extension && <Row label="Extension" value={data.extension} />}
          <Row label="Created" value={formatDateTime(data.createdAt)} />
          <Row label="Modified" value={formatDateTime(data.modifiedAt)} />
          {data.hash && <Row label="SHA-256" value={data.hash} mono />}
          {data.media && (
            <Row label="Media" value={JSON.stringify(data.media)} mono />
          )}
        </dl>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Close</Button>
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
      toast.error('Download failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  if (!node) return null;
  return (
    <Dialog open={open} onClose={onClose} title="Preview" className="max-w-3xl">
      <DialogHeader>
        <DialogTitle className="truncate">{node.name}</DialogTitle>
        <DialogDescription>{formatBytes(node.size)}</DialogDescription>
      </DialogHeader>
      {isLoading ? (
        <CenteredSpinner label="Loading preview…" />
      ) : isError ? (
        <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          {(error as ApiError)?.message ?? 'This file cannot be previewed.'}
        </div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto scrollbar-thin rounded-lg border border-border/60 bg-black/30 p-3 text-xs leading-relaxed">
          {data?.content}
        </pre>
      )}
      <DialogFooter>
        {canDownload && <Button variant="secondary" onClick={download}>Download</Button>}
        <Button variant="ghost" onClick={onClose}>Close</Button>
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
