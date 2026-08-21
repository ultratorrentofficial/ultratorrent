import { isGroup, type PolicyConditionNode } from './policy-document';

/**
 * Turn the selective half of a policy's conditions into a database filter.
 *
 * Discovery loads items by the policy's SCOPE and then evaluates every condition
 * in JavaScript. An unscoped policy therefore reads the whole library — tens of
 * thousands of rows — to answer a question like "movies in this library older
 * than 30 days", where three quarters of what it loaded could never match. On a
 * simulate that is worse than slow: the run is capped at 5,000 items, and the cap
 * is spent on rows the first condition was always going to reject. Observed on a
 * live library: a movies-only policy reached 623 of 3,499 movies because the
 * other 4,377 slots went to television.
 *
 * **This narrows what is LOADED. It never decides what matches.** Every pushed
 * condition is still evaluated in JavaScript exactly as before, so the filter can
 * only make the run cheaper, never change its answers. That is the property worth
 * protecting: a pushdown that narrowed differently from the evaluator would make
 * items disappear from consideration silently, which is indistinguishable from
 * the matching bugs this feature keeps producing.
 *
 * Three rules keep that true:
 *
 *  - **Only `all` branches.** A condition under `any` does not have to hold for
 *    the item to match, so narrowing on it would drop items the policy wants.
 *    An `any` subtree contributes nothing.
 *  - **Only facts backed by a real column**, compared with an operator whose SQL
 *    meaning is identical. Anything else is left to the evaluator.
 *  - **Boundaries are padded outward.** Day arithmetic here and in the evaluator
 *    round differently, so an exact boundary could exclude a row the evaluator
 *    would have matched. Loading a day's worth of extra rows costs nothing; not
 *    loading one that qualified is a silent wrong answer.
 */

const DAY_MS = 86_400_000;

/** Comparison operators whose SQL meaning matches the evaluator's exactly. */
type Cmp = 'gt' | 'gte' | 'lt' | 'lte';
const CMP: Record<Cmp, string> = { gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };

function isCmp(op: string): op is Cmp {
  return op in CMP;
}

/**
 * One condition as a Prisma filter fragment, or null when it cannot be pushed.
 *
 * Returning null is always safe: the item is loaded and the evaluator decides.
 */
function fragmentFor(
  field: string,
  operator: string,
  value: unknown,
  now: Date,
): Record<string, unknown> | null {
  switch (field) {
    /*
     * `eq` only. A `neq` on a nullable column excludes NULLs in SQL while the
     * evaluator calls a missing fact unmeasured — the same non-candidate either
     * way, but a difference in what the run reports having examined.
     */
    case 'metadata.mediaKind':
      return operator === 'eq' && typeof value === 'string' ? { mediaType: value } : null;

    case 'safety.libraryId':
      return operator === 'eq' && typeof value === 'string' ? { libraryId: value } : null;

    case 'metadata.releaseYear':
      if (typeof value !== 'number') return null;
      if (operator === 'eq') return { year: value };
      return isCmp(operator) ? { year: { [CMP[operator]]: value } } : null;

    /*
     * Age inverts: OLDER than N days means an EARLIER timestamp, so `gt` on days
     * becomes `lt` on the date. Padded by a day in the permissive direction
     * because the evaluator floors its day count and this does not.
     */
    case 'storage.addedAgeDays': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS);
      switch (operator) {
        case 'gt':
        case 'gte':
          return { createdAt: { lt: cutoff(Math.max(0, value - 1)) } };
        case 'lt':
        case 'lte':
          return { createdAt: { gt: cutoff(value + 1) } };
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Collect every pushable condition from the `all` spine of a condition tree.
 *
 * Nested `all` groups are still conjunctions, so their children qualify too; an
 * `any` group ends the descent.
 */
function collect(
  node: PolicyConditionNode,
  now: Date,
  out: Record<string, unknown>[],
): void {
  if (isGroup(node)) {
    if (node.type !== 'all') return; // an OR branch cannot narrow anything
    for (const child of node.children ?? []) collect(child, now, out);
    return;
  }
  const fragment = fragmentFor(node.field, node.operator, node.value, now);
  if (fragment) out.push(fragment);
}

/**
 * Does this condition tree bound the run to particular libraries?
 *
 * The validator warns that an unscoped policy "will evaluate every library",
 * deciding that from `scope` alone — so a policy pinned to one library by a
 * `safety.libraryId` CONDITION was told it was unbounded, and an automatic one
 * was refused outright. That contradicted this file, which already narrows the
 * query to that library before anything is examined.
 *
 * Answered here rather than in the validator so the two cannot drift: the same
 * `all`-spine walk decides both, and an `any` branch bounds nothing because its
 * other side can still match everything.
 */
export function boundsLibrary(conditions: PolicyConditionNode | undefined): boolean {
  if (!conditions) return false;
  const found: Record<string, unknown>[] = [];
  collect(conditions, new Date(), found);
  return found.some((fragment) => 'libraryId' in fragment);
}

/**
 * A Prisma `where` fragment narrowing the load to items that could still match.
 *
 * Empty when nothing is pushable, which simply restores the previous behaviour of
 * loading everything in scope.
 */
export function buildPushdownWhere(
  conditions: PolicyConditionNode | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!conditions) return {};
  const fragments: Record<string, unknown>[] = [];
  collect(conditions, now, fragments);
  // AND rather than a merged object: two fragments can address the same column
  // (`year > 2000` and `year < 2020`), and merging would silently drop one.
  return fragments.length ? { AND: fragments } : {};
}
