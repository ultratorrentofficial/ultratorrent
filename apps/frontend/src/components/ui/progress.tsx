import { cn } from '@/lib/utils';

export interface ProgressProps {
  value: number; // 0..1 fraction
  className?: string;
  indicatorClassName?: string;
  showLabel?: boolean;
}

export function Progress({ value, className, indicatorClassName, showLabel }: ProgressProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <div
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-white/[0.06]', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-500 ease-out',
          indicatorClassName,
        )}
        style={{ width: `${pct}%` }}
      />
      {showLabel && (
        <span className="absolute inset-0 grid place-items-center text-[10px] font-medium text-foreground/90">
          {pct.toFixed(0)}%
        </span>
      )}
    </div>
  );
}
