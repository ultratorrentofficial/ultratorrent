/**
 * Destination validation and masking.
 *
 * Pure and exported so the rules are testable without a database — the point of
 * a mask is that it is impossible to accidentally return the real value, and
 * that is easier to prove about a function than about a query.
 */

/**
 * Practical email validation.
 *
 * Deliberately not RFC 5322: a fully compliant regex accepts addresses no relay
 * will route and is unreadable. This rejects what actually gets typed wrong —
 * missing `@`, missing domain, spaces, a bare local part.
 */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(trimmed);
}

/**
 * `dennis@example.com` → `de•••@example.com`.
 *
 * Keeps the domain and two characters, which is enough for someone to recognise
 * their own address without revealing it to anyone reading over their shoulder —
 * or to anyone who obtains a database dump of masks.
 */
export function maskEmail(value: string): string {
  const [local, domain] = value.trim().split('@');
  if (!local || !domain) return '•••';
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}
