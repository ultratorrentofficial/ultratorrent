import { Prisma } from '@prisma/client';

/**
 * `AcquisitionRuleTemplateCandidate` must stay a mirror of
 * `RssRuleMatchCandidate`.
 *
 * The mirror is the whole reason there is no second match engine: generating a
 * rule is a column copy, so the one matcher in `rss/match-engine.ts` keeps
 * deciding everything. The moment the models drift, a preference an operator sets
 * on a template stops reaching the rule it generates — silently, because a
 * missing field is just a default.
 *
 * This test is the thing that notices. If it fails because a field was added to
 * one model, the fix is to add it to the other, or to add it to the documented
 * exception list below with a reason.
 */

const fields = (model: string) => {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`Model ${model} not found in the Prisma datamodel`);
  return m.fields;
};

/** Scalar (non-relation) field names of a model. */
const scalars = (model: string) =>
  fields(model)
    .filter((f) => f.kind !== 'object')
    .map((f) => f.name);

/**
 * Fields that legitimately exist on only one side.
 *
 * Each is here because it is NOT a preference:
 *  - the primary key and the two different foreign keys,
 *  - `lastMatchedAt` / `matchCount`, which are runtime statistics of a live rule
 *    and mean nothing on a template,
 *  - timestamps.
 */
const NOT_PREFERENCES = new Set([
  'id',
  'rssRuleId',
  'templateId',
  'lastMatchedAt',
  'matchCount',
  'createdAt',
  'updatedAt',
]);

describe('the template candidate mirrors the rule candidate', () => {
  const rule = scalars('RssRuleMatchCandidate').filter((f) => !NOT_PREFERENCES.has(f));
  const template = scalars('AcquisitionRuleTemplateCandidate').filter((f) => !NOT_PREFERENCES.has(f));

  it('carries every preference field a rule candidate has', () => {
    const missing = rule.filter((f) => !template.includes(f));
    expect(missing).toEqual([]);
  });

  it('carries no preference field a rule candidate cannot receive', () => {
    const extra = template.filter((f) => !rule.includes(f));
    expect(extra).toEqual([]);
  });

  it('agrees on the type of every shared field', () => {
    const ruleTypes = new Map(fields('RssRuleMatchCandidate').map((f) => [f.name, `${f.type}${f.isList ? '[]' : ''}${f.isRequired ? '' : '?'}`]));
    const mismatched = fields('AcquisitionRuleTemplateCandidate')
      .filter((f) => f.kind !== 'object' && !NOT_PREFERENCES.has(f.name))
      .filter((f) => ruleTypes.get(f.name) !== `${f.type}${f.isList ? '[]' : ''}${f.isRequired ? '' : '?'}`)
      .map((f) => f.name);
    expect(mismatched).toEqual([]);
  });

  /*
   * Sanity: if the exception list ever swallowed everything, the three tests
   * above would pass vacuously and stop protecting anything.
   */
  it('is comparing a meaningful set of fields', () => {
    expect(rule.length).toBeGreaterThanOrEqual(8);
    expect(rule).toEqual(
      expect.arrayContaining(['priorityOrder', 'matchType', 'requiredTerms', 'excludedTerms', 'qualityRules', 'sizeRules', 'feedScope']),
    );
  });
});
