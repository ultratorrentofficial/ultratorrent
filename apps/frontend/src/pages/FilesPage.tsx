import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Home,
  Info,
  Pencil,
  Trash2,
} from 'lucide-react';
import { PERMISSIONS, WS_EVENTS } from '@ultratorrent/shared';
import { ApiError, api, type FileNode } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { useAuth } from '@/auth/AuthContext';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { FilesToolbar } from '@/components/files/FilesToolbar';
import { FilesBulkToolbar } from '@/components/files/FilesBulkToolbar';
import { CleanupWizard } from '@/components/files/CleanupWizard';
import { TrashDrawer } from '@/components/files/TrashDrawer';
import {
  CreateFolderDialog,
  DeleteFileDialog,
  MoveCopyDialog,
  PreviewDialog,
  PropertiesDialog,
  RenameDialog,
} from '@/components/files/FileDialogs';

export function FilesPage() {
  const { hasPermission } = useAuth();
  const { t } = useTranslation('files');
  const toast = useToast();
  const qc = useQueryClient();
  const [path, setPath] = useState('/');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Dialog / drawer state
  const [createOpen, setCreateOpen] = useState(false);
  const [createParent, setCreateParent] = useState('/');
  const [renameNode, setRenameNode] = useState<FileNode | null>(null);
  const [moveCopy, setMoveCopy] = useState<{ mode: 'move' | 'copy'; paths: string[] } | null>(null);
  const [deleteState, setDeleteState] = useState<{ paths: string[]; name?: string } | null>(null);
  const [propsPath, setPropsPath] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<FileNode | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['files', path],
    queryFn: () => api.files.browse(path),
  });

  // Live refresh: any completed file/trash/cleanup op invalidates the listing.
  useEffect(() => {
    const events = [
      WS_EVENTS.FILES_OP_COMPLETED,
      WS_EVENTS.FILES_CLEANUP_COMPLETED,
      WS_EVENTS.FILES_TRASH_UPDATED,
    ] as const;
    const offs = events.map((e) =>
      wsClient.on(e, () => {
        void qc.invalidateQueries({ queryKey: ['files'] });
      }),
    );
    return () => offs.forEach((off) => off());
  }, [qc]);

  // Reset selection when navigating.
  useEffect(() => setSelected(new Set()), [path]);

  const segments = path.split('/').filter(Boolean);
  const goTo = (index: number) => setPath(index < 0 ? '/' : '/' + segments.slice(0, index + 1).join('/'));

  const items = useMemo(() => {
    const list = [...(data?.items ?? [])].sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name),
    );
    const q = search.trim().toLowerCase();
    return q ? list.filter((n) => n.name.toLowerCase().includes(q)) : list;
  }, [data, search]);

  const allSelected = items.length > 0 && items.every((n) => selected.has(n.path));
  const someSelected = items.some((n) => selected.has(n.path));

  const toggleOne = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  const selectAll = () => setSelected(new Set(items.map((n) => n.path)));
  const invert = () =>
    setSelected((prev) => new Set(items.filter((n) => !prev.has(n.path)).map((n) => n.path)));
  const clear = () => setSelected(new Set());

  const download = async (node: FileNode) => {
    try {
      await api.files.download(node.path);
    } catch (err) {
      toast.error(t('toast.downloadFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const bulkCleanup = async () => {
    setCleanupBusy(true);
    try {
      const res = await api.files.bulk({ operation: 'cleanup', paths: [...selected] });
      toast.success(
        t('toast.movedToTrash', { count: res.succeeded }),
        res.failed ? t('toast.someFailed', { count: res.failed }) : undefined,
      );
      await qc.invalidateQueries({ queryKey: ['files'] });
      clear();
    } catch (err) {
      toast.error(t('toast.cleanupFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setCleanupBusy(false);
    }
  };

  const openContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    const entries: ContextMenuEntry[] = [];
    if (node.isDirectory) {
      entries.push({ label: t('context.open'), icon: <FolderOpen className="h-4 w-4" />, onSelect: () => setPath(node.path) });
    } else {
      if (hasPermission(PERMISSIONS.FILES_PREVIEW))
        entries.push({ label: t('context.preview'), icon: <Eye className="h-4 w-4" />, onSelect: () => setPreviewNode(node) });
      if (hasPermission(PERMISSIONS.FILES_DOWNLOAD))
        entries.push({ label: t('context.download'), icon: <Download className="h-4 w-4" />, onSelect: () => void download(node) });
    }
    if (hasPermission(PERMISSIONS.FILES_RENAME))
      entries.push({ label: t('context.rename'), icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenameNode(node) });
    if (hasPermission(PERMISSIONS.FILES_MOVE))
      entries.push({ label: t('context.move'), icon: <FolderInput className="h-4 w-4" />, onSelect: () => setMoveCopy({ mode: 'move', paths: [node.path] }) });
    if (hasPermission(PERMISSIONS.FILES_COPY))
      entries.push({ label: t('context.copy'), icon: <Copy className="h-4 w-4" />, onSelect: () => setMoveCopy({ mode: 'copy', paths: [node.path] }) });
    if (hasPermission(PERMISSIONS.FILES_DELETE))
      entries.push({ label: t('context.delete'), icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => setDeleteState({ paths: [node.path], name: node.name }) });
    entries.push({ type: 'separator' });
    if (node.isDirectory && hasPermission(PERMISSIONS.FILES_CREATE_FOLDER))
      entries.push({ label: t('context.newFolder'), icon: <FolderPlus className="h-4 w-4" />, onSelect: () => { setCreateParent(node.path); setCreateOpen(true); } });
    entries.push({ label: t('context.properties'), icon: <Info className="h-4 w-4" />, onSelect: () => setPropsPath(node.path) });
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
      </div>

      <FilesToolbar
        search={search}
        onSearch={setSearch}
        onRefresh={() => refetch()}
        onNewFolder={() => { setCreateParent(path); setCreateOpen(true); }}
        onCleanup={() => setCleanupOpen(true)}
        onTrash={() => setTrashOpen(true)}
        onSelectAll={selectAll}
        onInvert={invert}
      />

      {/* Breadcrumbs */}
      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label={t('breadcrumb.ariaLabel')}>
        <button
          type="button"
          onClick={() => goTo(-1)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        >
          <Home className="h-3.5 w-3.5" /> {t('breadcrumb.root')}
        </button>
        {segments.map((seg, i) => (
          <Fragment key={i}>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
            <button
              type="button"
              onClick={() => goTo(i)}
              className={cn(
                'rounded-md px-2 py-1 transition-colors hover:bg-white/5',
                i === segments.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {seg}
            </button>
          </Fragment>
        ))}
      </nav>

      {selected.size > 0 && (
        <FilesBulkToolbar
          count={selected.size}
          cleanupBusy={cleanupBusy}
          onMove={() => setMoveCopy({ mode: 'move', paths: [...selected] })}
          onCopy={() => setMoveCopy({ mode: 'copy', paths: [...selected] })}
          onDelete={() => setDeleteState({ paths: [...selected] })}
          onCleanup={bulkCleanup}
          onClear={clear}
        />
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <CenteredSpinner label={t('list.loading')} />
          ) : isError ? (
            <ErrorState message={t('list.error')} onRetry={() => refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<FolderTree className="h-6 w-6" />} title={search ? t('list.noMatches') : t('list.emptyDirectory')} />
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onCheckedChange={() => (allSelected ? clear() : selectAll())}
                  aria-label={t('list.selectAll')}
                />
                <span className="text-xs text-muted-foreground">{t('list.itemCount', { count: items.length })}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {items.map((node) => (
                  <FileRow
                    key={node.path}
                    node={node}
                    selected={selected.has(node.path)}
                    canPreview={hasPermission(PERMISSIONS.FILES_PREVIEW)}
                    onToggle={() => toggleOne(node.path)}
                    onOpen={() => (node.isDirectory ? setPath(node.path) : hasPermission(PERMISSIONS.FILES_PREVIEW) && setPreviewNode(node))}
                    onContextMenu={(e) => openContextMenu(e, node)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

      {/* Dialogs */}
      <CreateFolderDialog open={createOpen} parentPath={createParent} onClose={() => setCreateOpen(false)} />
      <RenameDialog open={!!renameNode} node={renameNode} onClose={() => setRenameNode(null)} />
      {moveCopy && (
        <MoveCopyDialog
          open
          mode={moveCopy.mode}
          paths={moveCopy.paths}
          defaultDestination={path}
          onClose={() => setMoveCopy(null)}
          onDone={clear}
        />
      )}
      {deleteState && (
        <DeleteFileDialog
          open
          paths={deleteState.paths}
          name={deleteState.name}
          onClose={() => setDeleteState(null)}
          onDone={clear}
        />
      )}
      <PropertiesDialog open={!!propsPath} path={propsPath} onClose={() => setPropsPath(null)} />
      <PreviewDialog
        open={!!previewNode}
        node={previewNode}
        canDownload={hasPermission(PERMISSIONS.FILES_DOWNLOAD)}
        onClose={() => setPreviewNode(null)}
      />
      <CleanupWizard open={cleanupOpen} path={path} onClose={() => setCleanupOpen(false)} />
      <TrashDrawer open={trashOpen} onClose={() => setTrashOpen(false)} />
    </div>
  );
}

function FileRow({
  node,
  selected,
  canPreview,
  onToggle,
  onOpen,
  onContextMenu,
}: {
  node: FileNode;
  selected: boolean;
  canPreview: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation('files');
  const isDir = node.isDirectory;
  const clickable = isDir || canPreview;
  return (
    <li
      className={cn('flex items-center gap-3 px-4 py-3 transition-colors', selected && 'bg-primary/[0.06]')}
      onContextMenu={onContextMenu}
    >
      <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={t('list.selectRow', { name: node.name })} />
      <button
        type="button"
        onClick={onOpen}
        disabled={!clickable}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 text-left',
          clickable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        {isDir ? (
          <Folder className="h-5 w-5 shrink-0 text-primary" />
        ) : (
          <FileIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
        {!isDir && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(node.size)}</span>
        )}
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
          {formatRelativeTime(node.modifiedAt)}
        </span>
        {isDir && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
    </li>
  );
}
