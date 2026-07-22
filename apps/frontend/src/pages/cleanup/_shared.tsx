import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';

/** Bytes arrive as number or a BigInt-stringified value; coerce safely. */
export function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const STATUS_TONE: Record<string, BadgeVariant> = {
  // policies
  draft: 'secondary', validation_failed: 'destructive', ready: 'info',
  published: 'info', disabled: 'secondary', archived: 'secondary',
  // runs
  queued: 'secondary', running: 'info', completed: 'success', partial: 'warning',
  failed: 'destructive', cancelling: 'warning', cancelled: 'secondary',
  // plans
  pending_approval: 'warning', approved: 'info', rejected: 'destructive',
  executing: 'info', expired: 'secondary',
  // quarantine / candidates
  quarantined: 'warning', restored: 'success', purged: 'secondary',
  candidate: 'info', skipped: 'secondary', skipped_changed: 'warning',
};

/** A localized status badge whose colour reflects severity. */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('cleanup');
  const tone = STATUS_TONE[status] ?? 'secondary';
  // Fall back to the raw status when no translation exists (e.g. excluded_* reasons).
  const label = t(`status.${status}`, { defaultValue: status.replace(/_/g, ' ') });
  return <Badge variant={tone}>{label}</Badge>;
}

/** Consistent page header: title, one-line rationale, optional actions. */
export function CleanupHeader({
  title, subtitle, actions,
}: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
