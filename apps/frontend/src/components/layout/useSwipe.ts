import { useRef } from 'react';

interface SwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}

/**
 * Touch handlers that fire `onClose` on a predominantly-horizontal swipe in the
 * given direction — used to dismiss the mobile nav drawer by swiping it back
 * toward its edge. Spread the returned handlers onto the drawer element. Pure
 * (no listeners of its own), so it composes cleanly with React's synthetic events.
 */
export function useSwipeToDismiss(
  onClose: () => void,
  opts: { direction?: 'left' | 'right'; threshold?: number } = {},
): SwipeHandlers {
  const { direction = 'left', threshold = 60 } = opts;
  const start = useRef<{ x: number; y: number } | null>(null);

  return {
    onTouchStart: (e) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      // Ignore mostly-vertical drags (those are scrolls).
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (direction === 'left' && dx < -threshold) onClose();
      if (direction === 'right' && dx > threshold) onClose();
    },
  };
}
