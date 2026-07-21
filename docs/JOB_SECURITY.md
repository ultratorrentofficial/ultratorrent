# Job Security & Threat Model

Security model for the Unified Jobs Center. Applies UltraTorrent's platform standards
(JWT + `PermissionsGuard` + `@RequirePermissions`, DTO validation, pagination caps,
throttling, permission-scoped WebSockets, audit logging) plus job-specific controls. See
[SECURITY.md](SECURITY.md).

## Access control

- **Fifteen `jobs.*` permissions** gate the Center. Reads require `jobs.view`; each action
  requires its own permission (`jobs.cancel`/`pause`/`resume`/`retry`/`rerun`, `jobs.bulk_manage`);
  workers/settings/schedules have their own.
- **Visibility (server-enforced):** a viewer sees a job only if it is public, their own,
  ungated, or gated by a permission they hold. `jobs.view_all` / `jobs.admin` widen the set
  but **never** bypass field-level redaction.
- **Action guard (double gate):** an action requires *both* the `jobs.<action>` permission
  *and* the **job's own `requiredPermission`** — a user cannot cancel/retry/rerun a job they
  could not have initiated (no privilege escalation via the Jobs Center).

## Data protection

- **Redaction everywhere** (`platform/job-redaction.ts`): secret-looking keys
  (password/token/apiKey/authorization/…) are redacted, values bounded, at every persistence
  point — `inputSummary`, `resultSummary`, `warnings`, `metadata`, and every structured event.
- **`inputData` and `checkpoint` are never exposed** by any API — they exist only for
  re-execution/resume. Job **inputs must not carry raw secrets**; handlers resolve
  credentials from config at run time.
- **Errors are sanitized** — stack traces stripped (they can leak filesystem paths and
  internals); inline `key=secret` fragments redacted.
- **WebSocket** — the `jobs.*` channel is emitted **per-job to the room of the job's required
  permission**; a socket only receives events it is authorized to see. Payloads are bounded
  and carry no secrets.

## Preserved platform safety

The existing guarantees remain in force for job-driven work: file-path confinement,
Trash-first deletion, stale-plan validation, provider SSRF guards, and service-layer
authorization. The Jobs Center adds observation/control; it does not bypass them.

## Threat model

| Threat | Mitigation |
|--------|-----------|
| Forged / guessed job id | Visibility clause on every read; `404` (not `403`) for jobs you can't see |
| Unauthorized visibility | Per-job permission filter; `view_all` still redacts fields |
| Unauthorized cancellation | Action requires `jobs.<action>` **and** the job's own permission |
| Privilege escalation via retry/rerun | Same double gate — can't retry a job you couldn't start |
| Replay of destructive work | Destructive job types are `retryable: false`; rerun revalidates input |
| Secret leakage (input/result/events/diagnostics) | Central redaction + sanitized errors + `inputData`/`checkpoint` never returned |
| Payload manipulation | DTO validation (`whitelist` + `forbidNonWhitelisted`); definition `validateInput` |
| Dependency cycles | Cycle detection in the registry/dependency graph |
| Queue flooding | Idempotency keys; pagination caps; per-request bounds; throttling on mutating routes |
| Progress-event DoS | DB progress writes throttled; events bounded in size + retained/pruned |
| Worker impersonation | Single in-process worker keyed by host:pid; no external worker registration |
| Stale destructive plans | Existing stale-plan validation preserved; resume revalidates resources |
| Cross-user exposure | Own-job visibility; audit on every action (actor, IP, UA, job, result) |
| Diagnostic export leakage | Export limited to sanitized fields; gated by `jobs.view_diagnostics` |

## Audit

Every mutating action (cancel/pause/resume/retry/rerun, bulk, and administrative changes) is
recorded via `AuditService` with the actor, IP, user agent, job id(s), result, and any new
job id — through the same append-only audit trail as the rest of the platform.
