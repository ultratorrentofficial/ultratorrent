import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
export type { Paginated } from '@ultratorrent/shared';

/**
 * Reusable prev/next pager with a "showing X–Y of Z" summary. Renders nothing
 * when there's a single page. Localized via the `common.pagination.*` keys.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  busy,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  busy?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className ?? ''}`}>
      <span className="text-xs text-muted-foreground">
        {t('pagination.showing', { from, to, total })}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>
          {t('pagination.prev')}
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('pagination.page', { page, totalPages })}
        </span>
        <Button variant="outline" size="sm" disabled={page >= totalPages || busy} onClick={() => onPage(page + 1)}>
          {t('pagination.next')}
        </Button>
      </div>
    </div>
  );
}
