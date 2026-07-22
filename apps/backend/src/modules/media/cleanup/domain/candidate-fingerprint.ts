import { createHash } from 'node:crypto';

/**
 * The candidate fingerprint — what "the world has not changed" means.
 *
 * A plan is approved against a specific file in a specific state. Between approval
 * and execution the file may be replaced, resized, moved, re-probed, newly
 * protected, or watched. Executing anyway would delete something the operator
 * never actually approved, so the fingerprint is recomputed immediately before the
 * filesystem step and any difference stops that file with `skipped_changed`.
 *
 * It covers ONLY policy-relevant facts. Hashing everything would be strictly safer
 * in one direction and useless in practice: unrelated churn (an artwork refresh, a
 * metadata backfill) would invalidate every plan and operators would learn that
 * "changed" means nothing. `factKeys` comes from the pinned policy version, so each
 * policy pins exactly what it read.
 *
 * Protection and replacement state are ALWAYS included regardless of factKeys —
 * they are safety inputs to every decision, not optional conditions.
 */

export interface FingerprintInput {
  mediaFileId: string;
  /** Absolute canonical path at evaluation time. */
  path: string;
  fileSizeBytes: bigint | number;
  /** Filesystem mtime — catches a rewrite that preserved the size. */
  modifiedAtMs: number | null;
  /** Stable identity keys (reused duplicate-detection keys). */
  identityKeys: string[];
  policyVersionId: string;
  /** Facts the pinned policy version actually reads, by catalogue id. */
  facts: Record<string, unknown>;
  factKeys: string[];
  /** Safety state — always included. */
  isProtected: boolean;
  protectionIds: string[];
  /** The verified replacement this candidate depends on, if any. */
  replacementFileId: string | null;
}

/** Deterministic rendering: sorted keys, explicit nulls, no float ambiguity. */
function render(input: FingerprintInput): string {
  const parts: string[] = [
    `file:${input.mediaFileId}`,
    `path:${input.path}`,
    `size:${String(input.fileSizeBytes)}`,
    `mtime:${input.modifiedAtMs ?? 'null'}`,
    `identity:${[...input.identityKeys].sort().join(',')}`,
    `policyVersion:${input.policyVersionId}`,
    `protected:${input.isProtected ? '1' : '0'}`,
    `protections:${[...input.protectionIds].sort().join(',')}`,
    `replacement:${input.replacementFileId ?? 'none'}`,
  ];

  for (const key of [...input.factKeys].sort()) {
    parts.push(`fact:${key}=${stringify(input.facts[key])}`);
  }
  return parts.join('\n');
}

function stringify(v: unknown): string {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function candidateFingerprint(input: FingerprintInput): string {
  return createHash('sha256').update(render(input)).digest('hex');
}

/** Which inputs differ — so a skip can say WHY, not just "something changed". */
export function fingerprintDiff(a: FingerprintInput, b: FingerprintInput): string[] {
  const diffs: string[] = [];
  const cmp = (label: string, x: unknown, y: unknown) => {
    if (stringify(x) !== stringify(y)) diffs.push(label);
  };
  cmp('path', a.path, b.path);
  cmp('size', String(a.fileSizeBytes), String(b.fileSizeBytes));
  cmp('mtime', a.modifiedAtMs, b.modifiedAtMs);
  cmp('identity', [...a.identityKeys].sort().join(','), [...b.identityKeys].sort().join(','));
  cmp('protected', a.isProtected, b.isProtected);
  cmp('protections', [...a.protectionIds].sort().join(','), [...b.protectionIds].sort().join(','));
  cmp('replacement', a.replacementFileId, b.replacementFileId);
  for (const key of new Set([...a.factKeys, ...b.factKeys])) {
    cmp(`fact:${key}`, a.facts[key], b.facts[key]);
  }
  return diffs;
}
