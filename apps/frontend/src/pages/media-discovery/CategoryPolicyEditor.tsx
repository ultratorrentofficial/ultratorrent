import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Bell, Eye, Plus, ShieldAlert, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/**
 * The three-way category policy, plus the list that overrides all of it.
 *
 * Deliberately four lists rather than one allow-list. A single list can only say
 * what qualifies; it cannot express "tell me about Drama but never add it on your
 * own", which is the setting most operators actually want. Each bucket is shown
 * with its own verb so the difference is legible without reading documentation:
 * **monitor**, **tell me**, **hide**, and **never automatically**.
 *
 * The fourth is the one worth understanding. `blockedFromAuto` is evaluated
 * FIRST and beats every other list, so a Sci-Fi + Documentary title does not
 * auto-monitor when Documentary is blocked, however well Sci-Fi qualifies — and
 * a category may legitimately appear in both auto-monitor and blocked, which is
 * exactly how that sentence is expressed.
 */

export interface CategoryPolicy {
  autoMonitorCategories: string[];
  notifyOnlyCategories: string[];
  ignoreCategories: string[];
  blockedFromAutoCategories: string[];
}

type BucketKey = keyof CategoryPolicy;

const BUCKETS: Array<{
  key: BucketKey;
  icon: typeof Eye;
  className: string;
}> = [
  { key: 'autoMonitorCategories', icon: Eye, className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  { key: 'notifyOnlyCategories', icon: Bell, className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  { key: 'ignoreCategories', icon: Ban, className: 'border-white/15 bg-white/5 text-muted-foreground' },
  { key: 'blockedFromAutoCategories', icon: ShieldAlert, className: 'border-amber-400/40 bg-amber-400/10 text-amber-200' },
];

/** Genres the two providers actually emit, offered as one-click adds. */
const COMMON = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance',
  'Science Fiction', 'Sci-Fi', 'Thriller', 'War', 'Western',
  'Reality', 'Talk', 'News', 'Game Show', 'Espionage', 'Legal', 'Medical',
];

export function CategoryPolicyEditor({
  value,
  onChange,
}: {
  value: CategoryPolicy;
  onChange: (next: CategoryPolicy) => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const add = (key: BucketKey, raw: string) => {
    const category = raw.trim();
    if (!category) return;
    const current = value[key];
    if (current.some((c) => c.toLowerCase() === category.toLowerCase())) return;
    onChange({ ...value, [key]: [...current, category] });
    setDrafts((d) => ({ ...d, [key]: '' }));
  };

  const remove = (key: BucketKey, category: string) =>
    onChange({ ...value, [key]: value[key].filter((c) => c !== category) });

  /**
   * Auto-monitor and ignore are opposite verdicts, and the server refuses the
   * overlap. Flagging it here means an operator sees the contradiction while
   * typing rather than as a rejected save.
   */
  const contradictions = value.ignoreCategories.filter((c) =>
    value.autoMonitorCategories.some((a) => a.toLowerCase() === c.toLowerCase()),
  );

  /** Categories already used somewhere, so the quick-add does not re-offer them. */
  const used = new Set(
    Object.values(value).flat().map((c) => String(c).toLowerCase()),
  );

  return (
    <div className="space-y-3">
      {contradictions.length > 0 && (
        <p className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {t('policy.contradiction', { list: contradictions.join(', ') })}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {BUCKETS.map(({ key, icon: Icon, className }) => (
          <div key={key} className="space-y-1.5 rounded-md border border-white/10 p-2.5">
            <div className="flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5" />
              <span className="text-xs font-semibold">{t(`policy.${key}.title` as never)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t(`policy.${key}.help` as never)}</p>

            <div className="flex flex-wrap gap-1">
              {value[key].length === 0 && (
                <span className="text-[11px] italic text-muted-foreground">{t('policy.empty')}</span>
              )}
              {value[key].map((category) => (
                <span
                  key={category}
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${className}`}
                >
                  {category}
                  <button
                    type="button"
                    onClick={() => remove(key, category)}
                    aria-label={t('policy.remove', { category })}
                    className="opacity-60 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>

            <div className="flex gap-1">
              <Input
                value={drafts[key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add(key, drafts[key] ?? '');
                  }
                }}
                placeholder={t('policy.addPlaceholder')}
                className="h-7 text-xs"
              />
              <Button size="sm" variant="ghost" onClick={() => add(key, drafts[key] ?? '')}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="flex flex-wrap gap-1 pt-0.5">
              {COMMON.filter((c) => !used.has(c.toLowerCase()))
                .slice(0, 8)
                .map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => add(key, c)}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-white/10 hover:text-foreground"
                  >
                    + {c}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
