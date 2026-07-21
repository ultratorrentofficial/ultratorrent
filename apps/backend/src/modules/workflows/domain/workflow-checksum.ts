import { createHash } from 'node:crypto';
import type { WorkflowGraph } from './workflow-graph.types';

/**
 * A stable content checksum of a workflow graph — identifies graph/config changes so a
 * published version's identity is verifiable and version comparison can detect drift.
 * Canonicalizes to key-sorted JSON first (so object-key order and whitespace don't
 * change the hash), then SHA-256. Node/edge arrays are sorted by id so re-ordering the
 * same graph yields the same checksum; `viewport`/positions are ignored (pure layout,
 * not behaviour).
 */
export function graphChecksum(graph: WorkflowGraph): string {
  const normalized = normalizeForHash(graph);
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

/** Drop layout-only fields and sort collections by id so the hash reflects behaviour. */
function normalizeForHash(graph: WorkflowGraph): unknown {
  const nodes = [...(graph.nodes ?? [])]
    .map((n) => {
      // Exclude position (pure layout) from behavioural identity.
      const { position: _pos, metadata: _meta, ...rest } = n;
      void _pos;
      void _meta;
      return rest;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edges = [...(graph.edges ?? [])]
    .map((e) => {
      const { metadata: _meta, ...rest } = e;
      void _meta;
      return rest;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { schemaVersion: graph.schemaVersion, nodes, edges };
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
