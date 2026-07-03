import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface ContextMenuItem {
  type?: 'item';
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

export interface ContextMenuSeparator {
  type: 'separator';
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export interface ContextMenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

/**
 * Imperative right-click menu. Mirrors the inline UserMenu overlay pattern: a
 * full-screen click-catcher closes it, and the panel is positioned at the
 * cursor (clamped to the viewport). Render one instance per page and drive it
 * from `onContextMenu`.
 */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 0;
    const x = Math.min(state.x, window.innerWidth - w - 8);
    const y = Math.min(state.y, window.innerHeight - h - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        role="menu"
        className="absolute min-w-[12rem] overflow-hidden rounded-lg glass p-1.5 shadow-card animate-scale-in"
        style={{ left: pos?.x ?? state.x, top: pos?.y ?? state.y, visibility: pos ? 'visible' : 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {state.entries.map((entry, i) =>
          entry.type === 'separator' ? (
            <div key={`sep-${i}`} className="my-1 h-px bg-border/60" />
          ) : (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                if (entry.disabled) return;
                onClose();
                entry.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-40',
                entry.destructive
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-foreground hover:bg-white/5',
              )}
            >
              {entry.icon && <span className="shrink-0 text-muted-foreground">{entry.icon}</span>}
              <span className="truncate">{entry.label}</span>
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
