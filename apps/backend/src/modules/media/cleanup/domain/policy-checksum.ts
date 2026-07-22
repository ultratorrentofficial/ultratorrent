import { createHash } from 'node:crypto';
import type { CleanupPolicyDocument } from './policy-document';

/**
 * A stable content checksum for a policy document — version identity, and the
 * cheap way to tell "the operator reordered the JSON" from "the operator changed
 * what this policy does".
 *
 * Canonicalised by sorting object keys recursively, so a document that means the
 * same thing hashes the same regardless of key order. Array order IS preserved:
 * in an ANY group the order of branches is evaluation order, and in a branch list
 * it is precedence, so reordering is a real change.
 *
 * `notes` is excluded — prose about a policy does not change what it deletes.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = canonical(src[key]);
    }
    return out;
  }
  return value;
}

export function policyChecksum(doc: CleanupPolicyDocument): string {
  const { notes: _notes, ...rest } = doc ?? ({} as CleanupPolicyDocument);
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex');
}
