import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Info, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { api, type CleanupConditionDef } from '@/lib/api';

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

/**
 * A library chosen by name, storing its id.
 *
 * The condition compares an id, but nobody knows their libraries by UUID — the
 * text box this replaces asked for one and accepted anything, so a typo built a
 * policy that validated and then matched nothing at all.
 */
function LibraryValueInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  // Generic chrome ("any library", placeholders) — shared by both catalogues,
  // so it stays in the cleanup bundle rather than being duplicated per caller.
  const { t } = useTranslation('cleanup');
  const libraries = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.libraries });

  /*
   * A value already stored that no longer names a live library is kept as an
   * option rather than silently reset to blank. Losing it would rewrite the
   * operator's policy just by opening the editor, and hide the very mistake
   * they came to fix.
   */
  const options = (libraries.data ?? []).map((l) => ({ value: l.id, label: `${l.name} — ${l.path}` }));
  const current = String(value ?? '');
  const orphaned = current && !options.some((o) => o.value === current);

  return (
    <Select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      disabled={libraries.isLoading}
      options={[
        { value: '', label: t('builder.selectLibrary') },
        ...options,
        ...(orphaned ? [{ value: current, label: t('builder.unknownLibrary', { id: current }) }] : []),
      ]}
    />
  );
}

function ValueInput({
  def, value, onChange,
}: { def: CleanupConditionDef | undefined; value: unknown; onChange: (v: unknown) => void }) {
  // As above: operator names and input placeholders, not catalogue labels.
  const { t } = useTranslation('cleanup');
  if (!def) return null;

  // Checked before dataType: the value is a string, but not one to be typed.
  if (def.valueSource === 'library') return <LibraryValueInput value={value} onChange={onChange} />;

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
        placeholder={t('builder.hint.number')}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }
  if (def.dataType === 'date') {
    /*
     * A real date picker, not a text box. This field used to accept anything,
     * so "added to library" invited a number of days — which the server then
     * rejected as "expects an ISO date string", after the operator had already
     * built the rest of the policy around it. Sliced to YYYY-MM-DD because a
     * stored value may be a full timestamp and the control shows nothing at all
     * if the value does not match its format exactly.
     */
    return (
      <Input
        type="date"
        value={String(value ?? '').slice(0, 10)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (def.dataType === 'string[]') {
    return (
      <Input
        placeholder={t('builder.hint.list')}
        value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
        onChange={(e) => onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
      />
    );
  }
  return (
    <Input
      placeholder={t('builder.hint.text')}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export interface ConditionBuilderProps {
  /**
   * i18n bundle holding this catalogue's label and description keys.
   *
   * The builder is shared between Media Purge and the Activity Scheduler, whose
   * catalogues describe different facts and therefore live in different
   * bundles. Defaulted so the original caller is unchanged.
   */
  namespace?: 'cleanup' | 'torrents';
  node: ConditionGroup;
  catalog: CleanupConditionDef[];
  onChange: (next: ConditionGroup) => void;
}

export function ConditionBuilder({ node, catalog, onChange, namespace = 'cleanup' }: ConditionBuilderProps) {
  /*
   * Two translators, because two different things are being named.
   *
   * The builder's own chrome — "Match when", "any of these", "Add condition" —
   * belongs to the builder and lives in one bundle however many catalogues use
   * it. Only the CATALOGUE's labels and descriptions follow the caller. Running
   * both through the caller's bundle rendered raw keys on screen
   * ("builder.matchWhen", "builder.expects.number") for every catalogue except
   * the original one.
   */
  const { t } = useTranslation('cleanup');
  const { t: tLabel } = useTranslation(namespace);
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
                          {/* Marked, not hidden. A field nothing measures still has
                              to appear, or an existing rule that uses one would show
                              an empty picker; what it must not do is look like a
                              working choice. */}
                          {tLabel(d.labelKey.replace(/^cleanup\./, '') as 'cond.releaseYear')}
                          {d.unavailable ? ` — ${t('builder.unavailable')}` : ''}
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

                <Button variant="outline" size="sm" onClick={() => removeLeaf(i)} aria-label={t('builder.remove')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {def ? (
                <p className="mt-1.5 flex items-start gap-1.5 pl-1 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {tLabel(def.descriptionKey.replace(/^cleanup\./, '') as 'cond.releaseYear.desc')}
                    {/* The description says what the field MEANS; this says what it
                        will accept. Missing that second half is how a date field
                        gets a number typed into it. */}
                    <span className="ml-1 text-muted-foreground/70">
                      · {t(`builder.expects.${def.dataType}` as 'builder.expects.number')}
                    </span>
                  </span>
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
        {/*
          * `primary`, not `outline`: this is the only way to add a condition, and
          * as a bordered transparent button it read as decoration — operators did
          * not find it. The action that makes a screen usable is not a subtle one.
          */}
        <Button variant="primary" size="sm" onClick={addLeaf}>
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
