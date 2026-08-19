import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, Maximize2, Minus, Plus, RotateCw, Scan } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CenteredSpinner } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

/** Zoom bounds, as a multiple of the size the image is displayed at when fitted. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;

/**
 * A lightbox for image files: fit, zoom, pan and rotate.
 *
 * The zoom percentage shown is the *true* one — pixels on screen against pixels
 * in the file — not a multiple of the fitted size. That distinction is the whole
 * point of a "1:1" control: a 4K poster fitted into a dialog is displayed at
 * about 30%, and someone checking whether a rip is soft needs to see it at 100%.
 */
export function ImageViewer({ url, name }: { url: string; name: string }) {
  const { t } = useTranslation('files');
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  /** Zoom relative to the fitted size; 1 means "fitted". */
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  /*
   * What "fitted" means depends on both the image and the box it lands in, and
   * the box changes when the window does. Recomputed rather than measured once,
   * so the reported percentage stays true after a resize.
   *
   * A rotation of 90°/270° swaps which natural axis is constrained by which
   * container axis — without that, a rotated portrait image overflows its box.
   */
  const recomputeFit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !natural) return;
    const quarterTurned = rotation % 180 !== 0;
    const w = quarterTurned ? natural.h : natural.w;
    const h = quarterTurned ? natural.w : natural.h;
    // Never scale a small image UP to fill the box: an icon blown to 800px is
    // not what "fit" means, and it hides that the file is tiny.
    setFitScale(Math.min(el.clientWidth / w, el.clientHeight / h, 1));
  }, [natural, rotation]);

  useEffect(() => {
    recomputeFit();
    const observer = new ResizeObserver(recomputeFit);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [recomputeFit]);

  // A new image starts fitted and unrotated, whatever the last one was left at.
  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    setNatural(null);
    setStatus('loading');
  }, [url]);

  const effective = fitScale * zoom;
  const setZoomClamped = (next: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  const reset = () => { setZoom(1); setOffset({ x: 0, y: 0 }); };
  const actualSize = () => { setZoom(fitScale > 0 ? 1 / fitScale : 1); setOffset({ x: 0, y: 0 }); };

  // Panning only makes sense once the image is larger than its box; below that
  // there is nothing off-screen to drag into view.
  const pannable = zoom > 1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pannable) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) });
  };
  const endDrag = () => { drag.current = null; setDragging(false); };

  /*
   * Wheel-to-zoom has to be a native listener. React registers `wheel` at the
   * root as passive, so an `onWheel` handler cannot call preventDefault() and
   * the gesture would scroll the dialog while also zooming.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className={cn(
          'relative grid h-[62vh] place-items-center overflow-hidden rounded-lg border border-border/60 bg-black/40',
          pannable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onDoubleClick={() => (zoom === 1 ? actualSize() : reset())}
      >
        {status === 'loading' && <CenteredSpinner label={t('preview.loading')} />}
        {status === 'error' ? (
          <div className="flex flex-col items-center gap-2 p-6 text-sm text-muted-foreground">
            <ImageOff className="h-8 w-8" />
            {t('preview.imageFailed')}
          </div>
        ) : (
          <img
            src={url}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              setStatus('ready');
            }}
            onError={() => setStatus('error')}
            className={cn('max-w-none select-none', status !== 'ready' && 'invisible')}
            style={{
              width: natural ? natural.w : undefined,
              height: natural ? natural.h : undefined,
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${effective}) rotate(${rotation}deg)`,
              transformOrigin: 'center',
              // Nearest-neighbour past 3× so inspecting encoder artefacts shows
              // the pixels rather than the browser's smoothing of them.
              imageRendering: effective > 3 ? 'pixelated' : 'auto',
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="subtle" size="icon" onClick={() => setZoomClamped(zoom / 1.25)} aria-label={t('preview.zoomOut')}>
          <Minus className="h-4 w-4" />
        </Button>
        <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(effective * 100)}%
        </span>
        <Button variant="subtle" size="icon" onClick={() => setZoomClamped(zoom * 1.25)} aria-label={t('preview.zoomIn')}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="subtle" size="sm" onClick={reset}>
          <Maximize2 className="h-3.5 w-3.5" /> {t('preview.fit')}
        </Button>
        <Button variant="subtle" size="sm" onClick={actualSize}>
          <Scan className="h-3.5 w-3.5" /> {t('preview.actualSize')}
        </Button>
        <Button variant="subtle" size="icon" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label={t('preview.rotate')}>
          <RotateCw className="h-4 w-4" />
        </Button>
        {natural && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {t('preview.dimensions', { width: natural.w, height: natural.h })}
          </span>
        )}
      </div>
    </div>
  );
}
