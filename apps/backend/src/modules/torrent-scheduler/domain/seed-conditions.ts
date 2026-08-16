/**
 * Conditions a torrent must match before a seeding policy acts on it.
 *
 * The seeding rules were a fixed shape — a ratio, a time, a deadline — which
 * answers "when has this seeded enough?" but never "which torrents does this
 * rule apply to?". Everything else was scope: one policy per library, per
 * category, per rule. So "stop 4K films over 20 GB at ratio 1, but keep small
 * private-tracker TV to ratio 5" could not be written at all; it needed two
 * scopes that do not exist as such.
 *
 * Media Purge already solved the same problem with a condition document, and
 * an operator who has learned one builder should not have to learn a second.
 * The node shape here is deliberately identical to `PolicyConditionNode` so the
 * same UI can render both — but the CATALOG is not shared, because the facts
 * are different: a torrent has a tracker and a ratio, a library item has a
 * runtime and a watch count.
 *
 * ## Unknown is not false
 *
 * Every comparison can answer `unknown`, and it propagates. A tracker that has
 * not reported a ratio, a torrent whose completion time is missing — these are
 * gaps in what we measured, and treating a gap as "does not match" would let a
 * rule act on torrents it was never shown to cover. `unknown` blocks the action
 * exactly as `not_met` does; the difference is what the operator is told.
 */

export interface SeedConditionLeaf {
  type: 'condition';
  /** A {@link SEED_CONDITIONS} id. */
  field: string;
  operator: string;
  value: unknown;
}

export interface SeedConditionGroup {
  /** `all` = AND, `any` = OR. */
  type: 'all' | 'any';
  children: SeedConditionNode[];
}

export type SeedConditionNode = SeedConditionLeaf | SeedConditionGroup;

export type SeedConditionVerdict = 'met' | 'not_met' | 'unknown';

/** The facts a torrent presents to the matcher. Any may be absent. */
export interface SeedFacts {
  ratio?: number;
  /** Days since the torrent COMPLETED — the seeding obligation's clock. */
  ageDays?: number;
  sizeBytes?: number;
  /** Tracker host, as the engine reports it. */
  tracker?: string;
  category?: string;
  label?: string;
  /** True for a private tracker, where ratio obligations actually bite. */
  isPrivate?: boolean;
  name?: string;
  /** Library the payload was imported into, when it was. */
  libraryId?: string;
  /** Media Intake finished importing this. */
  importCompleted?: boolean;
  /** The library copy/hardlink was verified present. */
  libraryCopyVerified?: boolean;
  uploadedBytes?: number;
  seedMinutes?: number;
}

export type SeedConditionDataType = 'number' | 'string' | 'boolean' | 'bytes';

export interface SeedConditionDefinition {
  id: string;
  labelKey: string;
  descriptionKey: string;
  category: 'progress' | 'tracker' | 'content' | 'import';
  dataType: SeedConditionDataType;
  operators: string[];
  /** Key of {@link SeedFacts} this reads. */
  factKey: keyof SeedFacts;
  /** Where a valid value comes from, so the UI offers a picker not a UUID box. */
  valueSource?: 'library';
}

const EQ = ['eq', 'neq'];
const ORD = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const TEXT = ['eq', 'neq', 'contains', 'matches'];

const def = (d: SeedConditionDefinition): SeedConditionDefinition => d;

/**
 * What a seeding rule can be written against.
 *
 * Only facts BOTH shipped engines actually report. `seedMinutes` is the
 * cautionary tale: it is offered by the policy's time mode, neither engine
 * reports it, and so every time-based target has always evaluated to `unknown`
 * forever. It is present here for completeness and marked in its description,
 * rather than quietly looking like a working rule.
 */
export const SEED_CONDITIONS: SeedConditionDefinition[] = [
  // ── Progress ─────────────────────────────────────────────────────────────
  def({ id: 'seed.ratio', labelKey: 'sched.cond.ratio', descriptionKey: 'sched.cond.ratio.desc', category: 'progress', dataType: 'number', operators: ORD, factKey: 'ratio' }),
  def({ id: 'seed.ageDays', labelKey: 'sched.cond.ageDays', descriptionKey: 'sched.cond.ageDays.desc', category: 'progress', dataType: 'number', operators: ORD, factKey: 'ageDays' }),
  def({ id: 'seed.uploadedBytes', labelKey: 'sched.cond.uploaded', descriptionKey: 'sched.cond.uploaded.desc', category: 'progress', dataType: 'bytes', operators: ORD, factKey: 'uploadedBytes' }),
  def({ id: 'seed.seedMinutes', labelKey: 'sched.cond.seedMinutes', descriptionKey: 'sched.cond.seedMinutes.desc', category: 'progress', dataType: 'number', operators: ORD, factKey: 'seedMinutes' }),

  // ── Tracker ──────────────────────────────────────────────────────────────
  def({ id: 'seed.tracker', labelKey: 'sched.cond.tracker', descriptionKey: 'sched.cond.tracker.desc', category: 'tracker', dataType: 'string', operators: TEXT, factKey: 'tracker' }),
  def({ id: 'seed.isPrivate', labelKey: 'sched.cond.isPrivate', descriptionKey: 'sched.cond.isPrivate.desc', category: 'tracker', dataType: 'boolean', operators: EQ, factKey: 'isPrivate' }),

  // ── Content ──────────────────────────────────────────────────────────────
  def({ id: 'seed.sizeBytes', labelKey: 'sched.cond.size', descriptionKey: 'sched.cond.size.desc', category: 'content', dataType: 'bytes', operators: ORD, factKey: 'sizeBytes' }),
  def({ id: 'seed.name', labelKey: 'sched.cond.name', descriptionKey: 'sched.cond.name.desc', category: 'content', dataType: 'string', operators: TEXT, factKey: 'name' }),
  def({ id: 'seed.category', labelKey: 'sched.cond.category', descriptionKey: 'sched.cond.category.desc', category: 'content', dataType: 'string', operators: TEXT, factKey: 'category' }),
  def({ id: 'seed.label', labelKey: 'sched.cond.label', descriptionKey: 'sched.cond.label.desc', category: 'content', dataType: 'string', operators: TEXT, factKey: 'label' }),

  // ── Import ───────────────────────────────────────────────────────────────
  def({ id: 'seed.libraryId', labelKey: 'sched.cond.library', descriptionKey: 'sched.cond.library.desc', category: 'import', dataType: 'string', operators: EQ, factKey: 'libraryId', valueSource: 'library' }),
  def({ id: 'seed.importCompleted', labelKey: 'sched.cond.imported', descriptionKey: 'sched.cond.imported.desc', category: 'import', dataType: 'boolean', operators: EQ, factKey: 'importCompleted' }),
  def({ id: 'seed.libraryCopyVerified', labelKey: 'sched.cond.copyVerified', descriptionKey: 'sched.cond.copyVerified.desc', category: 'import', dataType: 'boolean', operators: EQ, factKey: 'libraryCopyVerified' }),
];

const BY_ID = new Map(SEED_CONDITIONS.map((c) => [c.id, c]));

/** The definition for a condition id, or undefined if the id is not known. */
export function seedConditionById(id: string): SeedConditionDefinition | undefined {
  return BY_ID.get(id);
}

function compare(operator: string, actual: unknown, expected: unknown): SeedConditionVerdict {
  // A fact we do not have cannot be shown to match OR to not match.
  if (actual === undefined || actual === null) return 'unknown';

  switch (operator) {
    case 'eq': return actual === expected ? 'met' : 'not_met';
    case 'neq': return actual !== expected ? 'met' : 'not_met';
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expected);
      // A non-numeric side is a malformed rule, not a false one.
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
      if (operator === 'gt') return a > b ? 'met' : 'not_met';
      if (operator === 'gte') return a >= b ? 'met' : 'not_met';
      if (operator === 'lt') return a < b ? 'met' : 'not_met';
      return a <= b ? 'met' : 'not_met';
    }
    case 'contains': {
      const hay = String(actual).toLowerCase();
      return hay.includes(String(expected).toLowerCase()) ? 'met' : 'not_met';
    }
    case 'matches': {
      try {
        return new RegExp(String(expected), 'i').test(String(actual)) ? 'met' : 'not_met';
      } catch {
        // An invalid pattern must not silently match everything.
        return 'unknown';
      }
    }
    default:
      return 'unknown';
  }
}

/**
 * Does this torrent match the policy's conditions?
 *
 * An absent or empty document means **every** torrent in scope matches, which
 * is the behaviour before conditions existed — adding the feature must not
 * change what an existing policy does.
 *
 * `all` returns `unknown` if any child is unknown and none is `not_met`: one
 * false child settles the group, but an unmeasured one leaves it genuinely
 * undecided rather than quietly true. `any` mirrors it.
 */
export function evaluateSeedConditions(
  node: SeedConditionNode | null | undefined,
  facts: SeedFacts,
): SeedConditionVerdict {
  if (!node) return 'met';

  if (node.type === 'all' || node.type === 'any') {
    if (!node.children?.length) return 'met';
    const verdicts = node.children.map((child) => evaluateSeedConditions(child, facts));
    if (node.type === 'all') {
      if (verdicts.includes('not_met')) return 'not_met';
      return verdicts.includes('unknown') ? 'unknown' : 'met';
    }
    if (verdicts.includes('met')) return 'met';
    return verdicts.includes('unknown') ? 'unknown' : 'not_met';
  }

  if (node.type !== 'condition') return 'unknown';
  const def_ = BY_ID.get(node.field);
  // An unknown field is a rule we cannot honour. Refusing to act on it is the
  // only safe reading — a policy naming a field that no longer exists must not
  // start matching everything.
  if (!def_) return 'unknown';
  return compare(node.operator, facts[def_.factKey], node.value);
}

/**
 * Facts that a seeding policy can already state as a target or a deadline.
 *
 * The seeding panel now has two ways to say the same thing — a `targetRatio`
 * field and a `seed.ratio` condition — and they do NOT mean the same thing:
 * a target says "seed until", a condition says "only these torrents". An
 * operator writing `targetRatio: 2` alongside `seed.ratio >= 2` has almost
 * certainly expressed one intent twice, and the two combine into a rule that
 * fires only once BOTH hold, which is not what either reads like.
 *
 * Rather than guess which one was meant, the pairing is refused at the door.
 */
export const SEED_FIELD_CONFLICTS: Array<{
  /** Condition id that clashes. */
  condition: string;
  /** Policy fields that already express it. */
  policyFields: string[];
}> = [
  { condition: 'seed.ratio', policyFields: ['targetRatio', 'minimumRatio'] },
  { condition: 'seed.ageDays', policyFields: ['maxAgeDays'] },
  { condition: 'seed.seedMinutes', policyFields: ['targetSeedMinutes', 'minimumSeedMinutes'] },
];

/** Every condition id used anywhere in a document. */
export function seedConditionFieldsUsed(node: SeedConditionNode | null | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (n: SeedConditionNode | null | undefined): void => {
    if (!n) return;
    if (n.type === 'condition') { out.add(n.field); return; }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

/**
 * Which policy fields are contradicted by this document, and by which
 * condition. Empty when the two halves are talking about different things.
 */
export function seedPolicyConflicts(
  policy: Record<string, unknown> & { conditions?: SeedConditionNode | null },
): Array<{ condition: string; policyField: string }> {
  const used = seedConditionFieldsUsed(policy.conditions);
  const clashes: Array<{ condition: string; policyField: string }> = [];
  for (const rule of SEED_FIELD_CONFLICTS) {
    if (!used.has(rule.condition)) continue;
    for (const field of rule.policyFields) {
      // Only a field the operator actually set counts; an absent one is not a
      // second statement of anything.
      if (policy[field] !== undefined && policy[field] !== null) {
        clashes.push({ condition: rule.condition, policyField: field });
      }
    }
  }
  return clashes;
}
