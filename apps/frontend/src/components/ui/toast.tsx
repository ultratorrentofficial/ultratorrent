import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastLevel = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: number;
  level: ToastLevel;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (toast: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const icons: Record<ToastLevel, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-info" />,
  success: <CheckCircle2 className="h-4 w-4 text-success" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" />,
  error: <XCircle className="h-4 w-4 text-destructive" />,
};

const accents: Record<ToastLevel, string> = {
  info: 'border-info/30',
  success: 'border-success/30',
  warning: 'border-warning/30',
  error: 'border-destructive/30',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { ...t, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 5000);
  }, []);

  const value: ToastContextValue = {
    toast,
    success: (title, description) => toast({ level: 'success', title, description }),
    error: (title, description) => toast({ level: 'error', title, description }),
    info: (title, description) => toast({ level: 'info', title, description }),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useTranslation('common');
  useEffect(() => {
    // Mount animation handled via CSS class.
  }, []);
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg glass border-l-2 p-3.5 shadow-card animate-fade-in-up',
        accents[toast.level],
      )}
    >
      <div className="mt-0.5">{icons[toast.level]}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs text-muted-foreground break-words">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('a11y.dismiss')}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
