import { useTranslation } from 'react-i18next';
import type { NotificationChannelType, NotificationSeverity } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Label } from '@/components/ui/input';

/** Everything the matrix can be narrowed by. Empty sets mean "no constraint". */
export interface EventFilters {
  search: string;
  categories: Set<string>;
  severities: Set<NotificationSeverity>;
  channels: Set<NotificationChannelType>;
  states: Set<'enabled' | 'disabled' | 'customized' | 'default' | 'missing_channel'>;
  deliveryModes: Set<string>;
}

export const EMPTY_FILTERS: EventFilters = {
  search: '',
  categories: new Set(),
  severities: new Set(),
  channels: new Set(),
  states: new Set(),
  deliveryModes: new Set(),
};

export function activeFilterCount(f: EventFilters): number {
  return (
    (f.search.trim() ? 1 : 0) +
    f.categories.size + f.severities.size + f.channels.size + f.states.size + f.deliveryModes.size
  );
}

const SEVERITIES: NotificationSeverity[] = ['info', 'success', 'warning', 'error', 'critical', 'security'];
const CHANNELS: NotificationChannelType[] = ['in_app', 'email', 'telegram', 'whatsapp', 'discord'];
const STATES = ['enabled', 'disabled', 'customized', 'default', 'missing_channel'] as const;
const MODES = ['immediate', 'quiet_hours_queue', 'daily_digest', 'weekly_digest', 'disabled'] as const;

/** Toggle one value in a Set without mutating the original. */
function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * The matrix's left filter panel.
 *
 * Categories come from the catalogue rather than a hard-coded list, so an event
 * added later appears without touching this file. Each group shows counts, because
 * "Downloads (7)" tells the user whether narrowing is worth it before they click.
 */
export function EventMatrixFilters({
  filters,
  onChange,
  categoryCounts,
}: {
  filters: EventFilters;
  onChange: (next: EventFilters) => void;
  categoryCounts: Array<{ category: string; count: number }>;
}) {
  const { t } = useTranslation('notificationCenter');
  const n = activeFilterCount(filters);

  const Group = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="space-y-1.5 border-t border-white/5 pt-3 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {children}
    </div>
  );

  const Row = ({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: React.ReactNode }) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </label>
  );

  return (
    <aside className="space-y-4 lg:w-60 lg:shrink-0">
      <div className="space-y-1.5">
        <Label htmlFor="ev-search">{t('matrix.filters.search')}</Label>
        <Input
          id="ev-search"
          value={filters.search}
          placeholder={t('matrix.filters.searchPlaceholder')}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
      </div>

      {n > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...EMPTY_FILTERS })}>
          {t('matrix.filters.clear', { count: n })}
        </Button>
      )}

      <Group label={t('matrix.filters.categories')}>
        {categoryCounts.map(({ category, count }) => (
          <Row
            key={category}
            checked={filters.categories.has(category)}
            onToggle={() => onChange({ ...filters, categories: toggle(filters.categories, category) })}
          >
            {t(`matrix.category.${category}`, { defaultValue: category })}{' '}
            <span className="text-xs text-muted-foreground">({count})</span>
          </Row>
        ))}
      </Group>

      <Group label={t('matrix.filters.severity')}>
        {SEVERITIES.map((s) => (
          <Row
            key={s}
            checked={filters.severities.has(s)}
            onToggle={() => onChange({ ...filters, severities: toggle(filters.severities, s) })}
          >
            {t(`matrix.severity.${s}`)}
          </Row>
        ))}
      </Group>

      <Group label={t('matrix.filters.channels')}>
        {CHANNELS.map((c) => (
          <Row
            key={c}
            checked={filters.channels.has(c)}
            onToggle={() => onChange({ ...filters, channels: toggle(filters.channels, c) })}
          >
            {t(`matrix.channel.${c}`)}
          </Row>
        ))}
      </Group>

      <Group label={t('matrix.filters.state')}>
        {STATES.map((s) => (
          <Row
            key={s}
            checked={filters.states.has(s)}
            onToggle={() => onChange({ ...filters, states: toggle(filters.states, s) })}
          >
            {t(`matrix.state.${s}`)}
          </Row>
        ))}
      </Group>

      <Group label={t('matrix.filters.deliveryMode')}>
        {MODES.map((m) => (
          <Row
            key={m}
            checked={filters.deliveryModes.has(m)}
            onToggle={() => onChange({ ...filters, deliveryModes: toggle(filters.deliveryModes, m) })}
          >
            {t(`matrix.mode.${m}`)}
          </Row>
        ))}
      </Group>
    </aside>
  );
}
