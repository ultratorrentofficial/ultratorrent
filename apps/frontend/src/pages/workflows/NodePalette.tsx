import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { NodeCategory, NodeDefinition } from './types';

const CATEGORY_ORDER: NodeCategory[] = [
  'trigger', 'condition', 'branch', 'action', 'delay', 'wait',
  'parallel', 'join', 'transform', 'variable', 'approval', 'subworkflow', 'end',
];

interface Props {
  nodes: NodeDefinition[];
  readOnly: boolean;
  onAdd: (def: NodeDefinition) => void;
}

/** The node palette — grouped by category, filterable, click-to-add. Catalog-driven, so it
 *  always reflects the real registered triggers/actions (fixes the automation UI drift). */
export function NodePalette({ nodes, readOnly, onAdd }: Props) {
  const { t } = useTranslation('workflows');
  const [q, setQ] = useState('');

  const grouped = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = term
      ? nodes.filter((n) => n.label.toLowerCase().includes(term) || n.type.toLowerCase().includes(term))
      : nodes;
    const byCat = new Map<NodeCategory, NodeDefinition[]>();
    for (const n of filtered) {
      const list = byCat.get(n.category) ?? [];
      list.push(n);
      byCat.set(n.category, list);
    }
    return CATEGORY_ORDER
      .filter((c) => byCat.has(c))
      .map((c) => ({ category: c, items: byCat.get(c)!.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [nodes, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('editor.palette')} className="pl-7" />
        </div>
        {!readOnly && <p className="mt-1 text-[10px] text-muted-foreground">{t('editor.paletteHint')}</p>}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {grouped.map(({ category, items }) => (
          <div key={category} className="mb-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`category.${category}`)}
            </div>
            <div className="space-y-1">
              {items.map((def) => (
                <button
                  key={def.type}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onAdd(def)}
                  className="flex w-full items-center justify-between rounded border bg-card px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  title={def.type}
                >
                  <span className="truncate">{def.label}</span>
                  {def.destructive && <span className="ml-1 shrink-0 text-[9px] text-red-500">!</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
