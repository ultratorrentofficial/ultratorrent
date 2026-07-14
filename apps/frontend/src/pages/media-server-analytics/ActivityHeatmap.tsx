import { useTranslation } from 'react-i18next';
import type { MediaServerHeatmap } from '@/lib/api';
import { heatColor } from './analytics-colors';
import { cn } from '@/lib/utils';

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Viewing-activity heatmap — a day-of-week × hour grid where each cell's fill
 * intensity scales with play count against the peak (single-hue sequential ramp).
 * Pure presentational; data + loading/empty come from the parent ChartCard.
 */
export function ActivityHeatmap({
  data,
  onCellClick,
}: {
  data: MediaServerHeatmap;
  /** Drill into the plays behind a cell. Empty cells are inert. */
  onCellClick?: (cell: { dow: number; hour: number; plays: number; label: string }) => void;
}) {
  const { t } = useTranslation('mediaServerAnalytics');
  // Index cells by dow*24+hour for O(1) lookup.
  const byKey = new Map(data.cells.map((c) => [c.dow * 24 + c.hour, c.plays]));
  const max = data.max || 1;
  const hourLabels = [0, 6, 12, 18, 23];

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[520px]">
        <div className="flex flex-col gap-1">
          {DOW_KEYS.map((dowKey, dow) => (
            <div key={dowKey} className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground">
                {t(`heatmap.days.${dowKey}`)}
              </span>
              <div className="flex flex-1 gap-1">
                {Array.from({ length: 24 }).map((_, hour) => {
                  const plays = byKey.get(dow * 24 + hour) ?? 0;
                  const label = `${t(`heatmap.days.${dowKey}`)} ${String(hour).padStart(2, '0')}:00`;
                  // An empty cell has nothing to drill into — leave it inert rather
                  // than open a drawer onto zero rows.
                  const clickable = !!onCellClick && plays > 0;
                  return (
                    <div
                      key={hour}
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      aria-label={clickable ? `${label} · ${plays} ${t('charts.plays')}` : undefined}
                      onClick={clickable ? () => onCellClick!({ dow, hour, plays, label }) : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onCellClick!({ dow, hour, plays, label });
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        'aspect-square flex-1 rounded-[3px] ring-1 ring-inset ring-white/[0.03]',
                        clickable &&
                          'cursor-pointer transition-shadow hover:ring-2 hover:ring-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                      style={{ background: heatColor(plays / max) }}
                      title={`${label} · ${plays} ${t('charts.plays')}`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          {/* Hour axis */}
          <div className="flex items-center gap-1 pt-0.5">
            <span className="w-8 shrink-0" />
            <div className="relative flex-1">
              {hourLabels.map((h) => (
                <span
                  key={h}
                  className="absolute text-[10px] text-muted-foreground"
                  style={{ left: `${(h / 23) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {String(h).padStart(2, '0')}
                </span>
              ))}
              <span className="invisible text-[10px]">0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
