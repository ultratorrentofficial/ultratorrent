import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

/** A KPI tile: icon, value, label, optional sub-line. */
export function KpiTile({
  icon: Icon,
  value,
  label,
  sub,
  tone,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.04]', tone)}>
            <Icon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold tabular-nums leading-tight">{value}</div>
            <div className="truncate text-xs text-muted-foreground">{label}</div>
          </div>
        </div>
        {sub && <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** A chart card: title + subtitle, with built-in loading / empty states. */
export function ChartCard({
  title,
  subtitle,
  loading,
  empty,
  emptyLabel,
  height = 260,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  empty?: boolean;
  emptyLabel: string;
  height?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </div>
        <div style={height ? { height } : undefined}>
          {loading ? (
            <CenteredSpinner />
          ) : empty ? (
            <div className="grid h-full place-items-center">
              <EmptyState title={emptyLabel} />
            </div>
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}
