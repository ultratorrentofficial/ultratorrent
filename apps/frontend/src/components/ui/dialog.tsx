import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Backdrop dismissal that only fires when the pointer press BEGAN on the
 * overlay. Without this, a click whose mousedown started inside the panel — a
 * drag, or selecting text and releasing outside — would land on the backdrop
 * and close the modal. We require both the initial press and the final click to
 * target the overlay itself, so interactions that start inside the dialog never
 * dismiss it. Spread the returned props onto the backdrop element.
 */
function useOverlayDismiss(onClose: () => void) {
  const pressStartedOnOverlay = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent) => {
      pressStartedOnOverlay.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent) => {
      if (pressStartedOnOverlay.current && e.target === e.currentTarget) onClose();
      pressStartedOnOverlay.current = false;
    },
  };
}

/** Lock body scroll while any overlay is open. */
function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [active]);
}

/** Close on Escape key. */
function useEscape(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onClose]);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
  /** Accessible label for the dialog. */
  title?: string;
}

export function Dialog({ open, onClose, className, children, title }: DialogProps) {
  const { t } = useTranslation('common');
  useScrollLock(open);
  useEscape(open, onClose);
  const overlayDismiss = useOverlayDismiss(onClose);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        {...overlayDismiss}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative z-10 w-full max-w-lg rounded-lg glass p-6 shadow-card animate-scale-in',
          'max-h-[90vh] overflow-y-auto scrollbar-thin',
          className,
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('a11y.closeDialog')}
          className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('mb-5 flex flex-col gap-1.5 pr-8', className)}>{children}</div>;
}

export function DialogTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h2 className={cn('text-lg font-semibold tracking-tight', className)}>{children}</h2>;
}

export function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>;
}

export function DialogFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('mt-6 flex items-center justify-end gap-2', className)}>{children}</div>
  );
}

export { useScrollLock, useEscape, useOverlayDismiss };
