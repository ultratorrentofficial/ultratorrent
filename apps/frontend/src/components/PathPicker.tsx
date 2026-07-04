import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Search,
} from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type FileNode } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

type PickerMode = 'directory' | 'file';

/** Join the effective absolute root with a "/"-prefixed root-relative path. */
function toAbsolute(root: string, rel: string): string {
  if (!rel || rel === '/') return root;
  return root.replace(/\/+$/, '') + rel;
}

/** If `abs` is inside `root`, return its "/"-prefixed relative form, else '/'. */
function toRelative(root: string, abs: string | undefined): string {
  if (!abs || !root) return '/';
  const r = root.replace(/\/+$/, '');
  if (abs === r) return '/';
  if (abs.startsWith(r + '/')) return abs.slice(r.length) || '/';
  return '/';
}

/**
 * Root-limited directory/file browser. Confined to the server's Default Root
 * Path — breadcrumbs cannot go above the root, and every path is validated
 * server-side by PathSafety. Reuses `GET /api/files` (browse) +
 * `POST /api/files/folders` (create). Returns the selected ABSOLUTE path.
 */
export function DirectoryPicker({
  open,
  onClose,
  mode = 'directory',
  initialPath,
  onSelect,
  title,
}: {
  open: boolean;
  onClose: () => void;
  mode?: PickerMode;
  initialPath?: string;
  onSelect: (absolutePath: string) => void;
  title?: string;
}) {
  const { t } = useTranslation('files');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canCreate = hasPermission(PERMISSIONS.FILES_CREATE_FOLDER);

  const rootQuery = useQuery({ queryKey: ['files', 'root'], queryFn: api.files.root, enabled: open });
  const root = rootQuery.data?.root ?? '';

  const [rel, setRel] = useState('/');
  const [filter, setFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
  const [creatingOpen, setCreatingOpen] = useState(false);

  // Seed the starting directory from initialPath once the root is known.
  useEffect(() => {
    if (open && root) {
      setRel(toRelative(root, initialPath));
      setSelectedFile(null);
      setFilter('');
      setCreatingOpen(false);
      setNewFolder('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root]);

  const browseQuery = useQuery({
    queryKey: ['files', 'browse', rel],
    queryFn: () => api.files.browse(rel),
    enabled: open && !!root,
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.files.createFolder(rel, name),
    onSuccess: () => {
      setCreatingOpen(false);
      setNewFolder('');
      queryClient.invalidateQueries({ queryKey: ['files', 'browse', rel] });
      toast.success(t('picker.folderCreated'));
    },
    onError: (err) =>
      toast.error(t('picker.createFolderFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const items = useMemo(() => {
    const all = browseQuery.data?.items ?? [];
    const visible = mode === 'file' ? all : all.filter((i) => i.isDirectory);
    const q = filter.trim().toLowerCase();
    return q ? visible.filter((i) => i.name.toLowerCase().includes(q)) : visible;
  }, [browseQuery.data, mode, filter]);

  const segments = rel.split('/').filter(Boolean);
  const crumbAt = (i: number) => '/' + segments.slice(0, i + 1).join('/');

  const currentAbsolute = toAbsolute(root, rel);
  const selectedAbsolute =
    mode === 'file' && selectedFile ? toAbsolute(root, selectedFile) : currentAbsolute;
  const canConfirm = mode === 'directory' || !!selectedFile;

  const confirm = () => {
    onSelect(selectedAbsolute);
    onClose();
  };

  const openItem = (item: FileNode) => {
    if (item.isDirectory) {
      setRel(item.path);
      setSelectedFile(null);
    } else if (mode === 'file') {
      setSelectedFile((cur) => (cur === item.path ? null : item.path));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title ?? t('picker.defaultTitle')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title ?? (mode === 'file' ? t('picker.selectFile') : t('picker.selectFolder'))}</DialogTitle>
        <DialogDescription>
          {t('picker.description')}
        </DialogDescription>
      </DialogHeader>

      {/* Breadcrumbs (confined to root) */}
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border/60 bg-white/[0.02] px-2 py-1.5 text-sm">
        <button
          type="button"
          onClick={() => {
            setRel('/');
            setSelectedFile(null);
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/5',
            rel === '/' ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
          title={t('picker.rootTitle')}
        >
          <Home className="h-3.5 w-3.5" /> {t('picker.root')}
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => {
                setRel(crumbAt(i));
                setSelectedFile(null);
              }}
              className={cn(
                'rounded px-1.5 py-0.5 hover:bg-white/5',
                i === segments.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* Filter + create-folder */}
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('picker.filterPlaceholder')}
            aria-label={t('picker.filterAria')}
            className="pl-8"
          />
        </div>
        {canCreate && (
          <Button variant="outline" size="sm" onClick={() => setCreatingOpen((v) => !v)}>
            <FolderPlus className="h-4 w-4" /> {t('picker.newFolder')}
          </Button>
        )}
      </div>

      {creatingOpen && canCreate && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFolder.trim()) createFolder.mutate(newFolder.trim());
            }}
            placeholder={t('picker.newFolderPlaceholder')}
            aria-label={t('picker.newFolderAria')}
          />
          <Button
            size="sm"
            onClick={() => createFolder.mutate(newFolder.trim())}
            loading={createFolder.isPending}
            disabled={!newFolder.trim()}
          >
            {t('picker.create')}
          </Button>
        </div>
      )}

      {/* Listing */}
      <div className="mt-3 max-h-[45vh] min-h-[12rem] overflow-y-auto rounded-md border border-border/60 scrollbar-thin">
        {browseQuery.isLoading || rootQuery.isLoading ? (
          <CenteredSpinner label={t('picker.loading')} />
        ) : browseQuery.isError ? (
          <ErrorState message={t('picker.loadError')} onRetry={() => browseQuery.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Folder className="h-6 w-6" />}
            title={filter ? t('picker.noMatches') : mode === 'file' ? t('picker.noFilesOrFolders') : t('picker.noSubfolders')}
            description={
              filter ? t('picker.tryDifferentFilter') : t('picker.emptyFolderHint')
            }
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {items.map((item) => {
              const isSelectedFile = mode === 'file' && selectedFile === item.path;
              return (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      isSelectedFile && 'bg-primary/10',
                    )}
                    aria-current={isSelectedFile ? 'true' : undefined}
                  >
                    {item.isDirectory ? (
                      <Folder className="h-4 w-4 shrink-0 text-info" />
                    ) : (
                      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.isDirectory && (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                    )}
                    {isSelectedFile && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Current selection + confirm */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {mode === 'file' && selectedFile ? t('picker.selectedFile') : t('picker.currentFolder')}
          </p>
          <p className="truncate font-mono text-xs" title={selectedAbsolute}>
            {selectedAbsolute}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('picker.cancel')}
          </Button>
          <Button onClick={confirm} disabled={!canConfirm}>
            <Check className="h-4 w-4" />
            {mode === 'file' ? t('picker.selectFileBtn') : t('picker.selectFolderBtn')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A path input with a Browse button that opens {@link DirectoryPicker}. Manual
 * typing is allowed by default (always validated server-side on use); set
 * `allowManualEntry={false}` to force selection via the browser.
 */
export function PathPicker({
  value,
  onChange,
  placeholder,
  mode = 'directory',
  allowManualEntry = true,
  disabled = false,
  id,
  pickerTitle,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mode?: PickerMode;
  allowManualEntry?: boolean;
  disabled?: boolean;
  id?: string;
  pickerTitle?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const { t } = useTranslation('files');
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={cn('flex items-center gap-2', className)}>
        <div className="min-w-0 flex-1">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full font-mono"
            readOnly={!allowManualEntry}
            disabled={disabled}
            aria-label={ariaLabel}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-label={t('picker.browseAria')}
          className="shrink-0"
        >
          <FolderOpen className="h-4 w-4" /> {t('picker.browse')}
        </Button>
      </div>
      <DirectoryPicker
        open={open}
        onClose={() => setOpen(false)}
        mode={mode}
        initialPath={value}
        onSelect={onChange}
        title={pickerTitle}
      />
    </>
  );
}
