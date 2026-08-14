import type { Request } from 'express';

/**
 * Who made a request, and from where — the fields an audit row needs beyond the
 * action itself.
 *
 * Structurally the same as the `AuditEntry` subset `AuditService.record` reads,
 * so it spreads straight into a `record()` call.
 */
export interface RequestAuditContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Extract the caller's address and client from a request.
 *
 * **`x-forwarded-for` first, `req.ip` second.** Both deployments sit behind a
 * reverse proxy, so `req.ip` is the proxy — recording it produces an audit trail
 * where every action appears to come from the gateway. This is not hypothetical:
 * controllers each grew their own copy of this two-line extraction and they did
 * not stay identical, so some rows carry the real client and others the hop in
 * front of it. One helper, so the next audited endpoint cannot pick the wrong one.
 *
 * A comma-joined `x-forwarded-for` chain is kept whole rather than split to its
 * first entry: the header is client-supplied and trivially spoofed, so the full
 * chain is the honest record of what arrived, and trimming it would imply a
 * confidence the value does not carry.
 */
export function reqAuditContext(req: Request): RequestAuditContext {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip,
    userAgent: req.headers['user-agent'],
  };
}
