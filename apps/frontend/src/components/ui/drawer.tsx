import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEscape, useOverlayDismiss, useScrollLock } from './dialog';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
  title?: string;
  side?: 'right' | 'left';
}

/** A right-side (default) sliding panel used for detail views. */
export function Drawer({ open, onClose, className, children, title, side = 'right' }: DrawerProps) {
  useScrollLock(open);
  useEscape(open, onClose);
  const overlayDismiss = useOverlayDismiss(onClose);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        {...overlayDismiss}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'absolute top-0 bottom-0 flex w-full max-w-xl flex-col glass shadow-card animate-slide-in-right',
          side === 'right' ? 'right-0' : 'left-0',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DrawerHeader({
  onClose,
  className,
  children,
}: {
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border/60 p-5',
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('a11y.closePanel')}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function DrawerBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex-1 overflow-y-auto scrollbar-thin p-5', className)}>{children}</div>
  );
}

export function DrawerFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('border-t border-border/60 p-4 flex items-center gap-2', className)}>
      {children}
    </div>
  );
}
