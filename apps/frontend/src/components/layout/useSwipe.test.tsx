import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useSwipeToDismiss } from './useSwipe';

function Swipeable({ onClose, direction }: { onClose: () => void; direction?: 'left' | 'right' }) {
  const h = useSwipeToDismiss(onClose, { direction, threshold: 60 });
  return <div data-testid="target" onTouchStart={h.onTouchStart} onTouchEnd={h.onTouchEnd} />;
}

function swipe(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.touchStart(el, { touches: [{ clientX: from.x, clientY: from.y }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: to.x, clientY: to.y }] });
}

describe('useSwipeToDismiss', () => {
  it('fires onClose on a left swipe past the threshold', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Swipeable onClose={onClose} direction="left" />);
    swipe(getByTestId('target'), { x: 200, y: 100 }, { x: 100, y: 110 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a short swipe', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Swipeable onClose={onClose} direction="left" />);
    swipe(getByTestId('target'), { x: 200, y: 100 }, { x: 170, y: 100 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a mostly-vertical drag (a scroll)', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Swipeable onClose={onClose} direction="left" />);
    swipe(getByTestId('target'), { x: 200, y: 100 }, { x: 160, y: 300 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not fire on a wrong-direction swipe', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Swipeable onClose={onClose} direction="left" />);
    swipe(getByTestId('target'), { x: 100, y: 100 }, { x: 220, y: 100 });
    expect(onClose).not.toHaveBeenCalled();
  });
});
