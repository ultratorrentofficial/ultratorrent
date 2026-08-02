import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Info, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { CleanupConditionDef } from '@/lib/api';

/**
 * Build a policy's conditions by picking, not by typing JSON.
 *
 * The draft editor was a raw JSON textarea — authoring a policy meant knowing a
 * 63-entry catalogue by heart, and the labels that catalogue referenced had never
 * been translated, so nothing could have rendered them even if something asked.
 * "Extremely hard to understand, configure and use" was an accurate description
 * of a text box.
 *
 * Three things carry the weight here:
 *
 *  - **Every field explains itself.** The catalogue already carried a description
 *    per condition; those are now written and shown inline. The difference
 *    between "Runtime" (what the provider claims) and "Duration" (what your file
 *    measures) is the kind of thing nobody guesses.
 *  - **Operators come from the field.** A boolean offers is/is not; a number
 *    offers the ordering comparisons. An impossible combination cannot be
 *    expressed, so it cannot be saved and then fail validation later.
 *  - **Elevated fields are marked.** Playback conditions depend on history your
 *    media server may not have reported; a rule resting on "never watched" is
 *    only as true as that feed.
 */

export type ConditionLeaf = { type: 'condition'; field: string; operator: string; value: unknown };
export type ConditionGroup = { type: 'all' | 'any'; children: ConditionNode[] };
export type ConditionNode = ConditionLeaf | ConditionGroup;

export function isGroup(n: ConditionNode): n is ConditionGroup {
  return n.type === 'all' || n.type === 'any';
}

/** Operator wording, in the order a person reads it: "<field> <operator> <value>". */
const OPERATOR_LABEL: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  matches: 'matches',
};

function defaultValueFor(def: CleanupConditionDef | undefined): unknown {
  if (!def) return '';
  if (def.dataType === 'boolean') return true;
  if (def.dataType === 'number') return 0;
  if (def.dataType === 'enum') return def.enumValues?.[0] ?? '';
  return '';
}

function ValueInput({
  def, value, onChange,
}: { def: CleanupConditionDef | undefined; value: unknown; onChange: (v: unknown) => void }) {
  if (!def) return null;

  if (def.dataType === 'boolean') {
    return (
      <Select value={String(value)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (def.dataType === 'enum') {
    return (
      <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(def.enumValues ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
      </Select>
    );
  }
  if (def.dataType === 'number') {
    return (
      <Input
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }
  return <Input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}

export interface ConditionBuilderProps {
  node: ConditionGroup;
  catalog: CleanupConditionDef[];
  onChange: (next: ConditionGroup) => void;
}

export function ConditionBuilder({ node, catalog, onChange }: ConditionBuilderProps) {
  const { t } = useTranslation('cleanup');
  const byId = new Map(catalog.map((c) => [c.id, c]));

  // Grouped so a 63-entry list is navigable: the categories are the catalogue's own.
  const grouped = catalog.reduce<Record<string, CleanupConditionDef[]>>((acc, c) => {
    (acc[c.category] ??= []).push(c);
    return acc;
  }, {});

  const leaves = node.children.filter((c): c is ConditionLeaf => !isGroup(c));
  const nestedCount = node.children.length - leaves.length;

  const setLeaf = (index: number, next: ConditionLeaf) => {
    const children = [...node.children];
    let seen = -1;
    for (let i = 0; i < children.length; i += 1) {
      if (isGroup(children[i])) continue;
      seen += 1;
      if (seen === index) { children[i] = next; break; }
    }
    onChange({ ...node, children });
  };

  const removeLeaf = (index: number) => {
    const children: ConditionNode[] = [];
    let seen = -1;
    for (const c of node.children) {
      if (isGroup(c)) { children.push(c); continue; }
      seen += 1;
      if (seen !== index) children.push(c);
    }
    onChange({ ...node, children });
  };

  const addLeaf = () => {
    const first = catalog[0];
    onChange({
      ...node,
      children: [
        ...node.children,
        { type: 'condition', field: first.id, operator: first.operators[0], value: defaultValueFor(first) },
      ],
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('builder.matchWhen')}</span>
        <Select
          value={node.type}
          onChange={(e) => onChange({ ...node, type: e.target.value as 'all' | 'any' })}
          className="w-auto"
        >
          <option value="all">{t('builder.all')}</option>
          <option value="any">{t('builder.any')}</option>
        </Select>
        <span className="text-muted-foreground">{t('builder.ofThese')}</span>
      </div>

      {leaves.length === 0 ? (
        <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-muted-foreground">
          {t('builder.noConditions')}
        </p>
      ) : null}

      <div className="space-y-2">
        {leaves.map((leaf, i) => {
          const def = byId.get(leaf.field);
          const ops = def?.operators ?? ['eq'];
          return (
            <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={leaf.field}
                  onChange={(e) => {
                    const next = byId.get(e.target.value);
                    setLeaf(i, {
                      type: 'condition',
                      field: e.target.value,
                      // The old operator may be illegal for the new field.
                      operator: next?.operators[0] ?? 'eq',
                      value: defaultValueFor(next),
                    });
                  }}
                  className="min-w-[14rem] flex-1"
                >
                  {Object.entries(grouped).map(([cat, defs]) => (
                    <optgroup key={cat} label={t(`builder.category.${cat}` as 'builder.category.metadata')}>
                      {defs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {t(d.labelKey.replace(/^cleanup\./, '') as 'cond.releaseYear')}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>

                <Select
                  value={leaf.operator}
                  onChange={(e) => setLeaf(i, { ...leaf, operator: e.target.value })}
                  className="w-auto"
                >
                  {ops.map((op) => <option key={op} value={op}>{OPERATOR_LABEL[op] ?? op}</option>)}
                </Select>

                <div className="min-w-[8rem] flex-1">
                  <ValueInput def={def} value={leaf.value} onChange={(v) => setLeaf(i, { ...leaf, value: v })} />
                </div>

                <Button variant="ghost" size="sm" onClick={() => removeLeaf(i)} aria-label={t('builder.remove')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {def ? (
                <p className="mt-1.5 flex items-start gap-1.5 pl-1 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t(def.descriptionKey.replace(/^cleanup\./, '') as 'cond.releaseYear.desc')}</span>
                </p>
              ) : null}

              {def?.safetyLevel === 'elevated' ? (
                <p className="mt-1 flex items-start gap-1.5 pl-1 text-xs text-warning">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('builder.elevated')}</span>
                </p>
              ) : null}

              {def?.requiresMeasuredData ? (
                <p className="mt-1 pl-6 text-xs text-muted-foreground">{t('builder.measured')}</p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={addLeaf}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('builder.addCondition')}
        </Button>
        {nestedCount > 0 ? (
          <Badge variant="secondary">{t('builder.nested', { count: nestedCount })}</Badge>
        ) : null}
      </div>
    </div>
  );
}
