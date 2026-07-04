import { useTranslation } from 'react-i18next';
import { CheckSquare, FlipHorizontal, FolderPlus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface FilesToolbarProps {
  search: string;
  onSearch: (v: string) => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onCleanup: () => void;
  onTrash: () => void;
  onSelectAll: () => void;
  onInvert: () => void;
}

export function FilesToolbar({
  search,
  onSearch,
  onRefresh,
  onNewFolder,
  onCleanup,
  onTrash,
  onSelectAll,
  onInvert,
}: FilesToolbarProps) {
  const { hasPermission } = useAuth();
  const { t } = useTranslation('files');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('toolbar.filterPlaceholder')}
          className="pl-8"
        />
      </div>
      <Button variant="secondary" size="sm" onClick={onRefresh}>
        <RefreshCw className="h-4 w-4" /> {t('toolbar.refresh')}
      </Button>
      {hasPermission(PERMISSIONS.FILES_CREATE_FOLDER) && (
        <Button variant="secondary" size="sm" onClick={onNewFolder}>
          <FolderPlus className="h-4 w-4" /> {t('toolbar.newFolder')}
        </Button>
      )}
      {hasPermission(PERMISSIONS.FILES_CLEANUP) && (
        <Button variant="secondary" size="sm" onClick={onCleanup}>
          <Sparkles className="h-4 w-4" /> {t('toolbar.cleanup')}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onSelectAll} title={t('toolbar.selectAllTitle')}>
        <CheckSquare className="h-4 w-4" /> {t('toolbar.selectAll')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onInvert} title={t('toolbar.invertTitle')}>
        <FlipHorizontal className="h-4 w-4" /> {t('toolbar.invert')}
      </Button>
      {hasPermission(PERMISSIONS.FILES_VIEW) && (
        <Button variant="ghost" size="sm" onClick={onTrash}>
          <Trash2 className="h-4 w-4" /> {t('toolbar.trash')}
        </Button>
      )}
    </div>
  );
}
