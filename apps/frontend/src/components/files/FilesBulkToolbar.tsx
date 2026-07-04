import { useTranslation } from 'react-i18next';
import { Copy, FolderInput, Sparkles, Trash2, X } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';

export interface FilesBulkToolbarProps {
  count: number;
  onMove: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onCleanup: () => void;
  onClear: () => void;
  cleanupBusy?: boolean;
}

export function FilesBulkToolbar({
  count,
  onMove,
  onCopy,
  onDelete,
  onCleanup,
  onClear,
  cleanupBusy,
}: FilesBulkToolbarProps) {
  const { hasPermission } = useAuth();
  const { t } = useTranslation('files');
  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 animate-fade-in">
      <button
        type="button"
        onClick={onClear}
        className="rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        aria-label={t('bulk.clearSelection')}
      >
        <X className="h-4 w-4" />
      </button>
      <span className="text-sm font-medium">{t('bulk.selected', { count })}</span>
      <div className="mx-1 h-5 w-px bg-border" />

      {hasPermission(PERMISSIONS.FILES_MOVE) && (
        <Button variant="ghost" size="sm" onClick={onMove}>
          <FolderInput className="h-4 w-4" /> {t('bulk.move')}
        </Button>
      )}
      {hasPermission(PERMISSIONS.FILES_COPY) && (
        <Button variant="ghost" size="sm" onClick={onCopy}>
          <Copy className="h-4 w-4" /> {t('bulk.copy')}
        </Button>
      )}
      {hasPermission(PERMISSIONS.FILES_CLEANUP) && (
        <Button variant="ghost" size="sm" loading={cleanupBusy} onClick={onCleanup}>
          <Sparkles className="h-4 w-4" /> {t('bulk.cleanupSelected')}
        </Button>
      )}
      {hasPermission(PERMISSIONS.FILES_DELETE) && (
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> {t('bulk.delete')}
        </Button>
      )}
    </div>
  );
}
