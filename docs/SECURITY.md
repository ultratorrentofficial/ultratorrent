# Security

UltraTorrent controls a service that can move and delete files on disk, so
security is a first-class concern. This document describes the controls that are
implemented and how to deploy and report responsibly.

- [Password hashing](#password-hashing)
- [Tokens](#tokens)
- [Two-factor authentication (2FA)](#two-factor-authentication-2fa)
- [RBAC & the permission catalog](#rbac--the-permission-catalog)
- [Rate limiting](#rate-limiting)
- [HTTP hardening (Helmet)](#http-hardening-helmet)
- [Input validation](#input-validation)
- [Audit logging](#audit-logging)
- [File-path validation](#file-path-validation)
- [Secrets management](#secrets-management)
- [Engine control surface](#engine-control-surface)
- [Reporting a vulnerability](#reporting-a-vulnerability)

---

## Password hashing

Passwords are hashed with **Argon2id** (`argon2` library, `type: argon2.argon2id`)
— a memory-hard algorithm resistant to GPU/ASIC cracking. Plaintext passwords are
never stored or logged.

- Hashes are computed at user creation/seed time and on password change.
- **Login is timing-hardened:** when a username doesn't exist, the service still
  runs an Argon2 `verify` against a dummy hash so the response time does not
  reveal whether an account exists.
- Changing a password **revokes all of that user's refresh tokens**, ending every
  active session.

## Tokens

Authentication uses **short-lived JWT access tokens** plus **rotating refresh
tokens with reuse detection**.

```
login ──► access JWT (15m)            refresh ──► rotate (revoke old, issue new in same family)
          + refresh token             reuse of a revoked token ──► burn the whole family
          (<family>.<secret>)
```

- **Access tokens** are JWTs (default TTL `15m`, `JWT_ACCESS_TTL`) carrying the
  user id, username, roles, and flattened permissions. They are validated by the
  Passport JWT strategy on every protected request; tokens whose `type` is not
  `access` are rejected.
- **Refresh tokens** are opaque random secrets (`randomBytes(48)`), grouped into
  a **family** and stored only as a **SHA-256 hash** in the database — never in
  plaintext. The token presented to the client is `"<family>.<secret>"`.
- **Rotation:** each `POST /api/auth/refresh` revokes the presented token and
  issues a fresh one in the same family.
- **Reuse detection:** if an already-revoked refresh token is presented again
  (the hallmark of a stolen/replayed token), the **entire token family is
  revoked**, forcing re-authentication. Expired tokens are likewise rejected.
- Logout and password changes revoke refresh tokens server-side, so they cannot
  be silently replayed.

> Set strong, unique values for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`. The
> built-in development defaults are insecure and must be overridden in any shared
> deployment.

## Two-factor authentication (2FA)

UltraTorrent supports **TOTP** (time-based one-time passwords, RFC 6238) as an
optional second factor, compatible with any standard authenticator app (Google
Authenticator, Authy, 1Password, …). It is implemented by `TwoFactorService`
using `otplib`, with a **30-second step** and a **±1 step tolerance** for clock
skew.

```
login (password OK) ─► 2FA off ─────────────────────────► issue tokens
                       2FA on, no code ──► 401 { twoFactorRequired: true }
                       2FA on, valid TOTP or recovery code ─► issue tokens
```

**Enrollment is confirmed, not blind.** `POST /api/account/2fa/setup` generates a
secret and returns an `otpauth://` URI plus a QR data-URL. The secret is stored
**encrypted at rest** but 2FA is **not active** until the user proves possession
by submitting a valid code to `POST /api/account/2fa/enable`. Only then is
`totpEnabled` set.

**Secret at rest.** The TOTP secret is encrypted with **AES-256-GCM**
(`SecretCipher`) using a key derived from `ENCRYPTION_KEY` (see
[Secrets management](#secrets-management)); the plaintext seed is never stored.

**Recovery codes.** Enabling 2FA returns **10 single-use recovery codes**, shown
**once**. They are stored only as **SHA-256 hashes**; at login a recovery code is
accepted in place of a TOTP code and is **consumed** (removed) on use, so it
cannot be replayed. Codes can be regenerated at `POST /api/account/2fa/recovery`
(requires a current TOTP code).

**Login enforcement.** The password is always verified **first**; the second
factor is only checked once the password is correct. A missing code raises a
`TwoFactorRequiredException` → `401 { twoFactorRequired: true }`, which the
frontend uses to prompt for the code. This pending-2FA response is **not** recorded
as a failed login in the audit log; an actually-wrong code is a normal `401`.

**Disabling** 2FA (`POST /api/account/2fa/disable`) requires the account
**password** as confirmation and clears the secret, the `totpEnabled` flag, and all
recovery codes. All 2FA management endpoints live under `/api/account/2fa/*` and
are authenticated as the **current user** (a user can only manage their own 2FA).

## RBAC & the permission catalog

Authorization is **permission-based**. Every protected route declares the
permission(s) it needs via `@RequirePermissions(...)`; the `PermissionsGuard`
verifies the authenticated principal holds **all** of them. `SUPER_ADMIN` bypasses
granular checks. The catalog is defined once in `packages/shared/src/permissions.ts`
and shared by backend guards and frontend capability checks.

### Permission catalog

| Group | Permission key | Constant |
|-------|----------------|----------|
| **Torrents** | `torrents.view` | `TORRENTS_VIEW` |
| | `torrents.add` | `TORRENTS_ADD` |
| | `torrents.pause` | `TORRENTS_PAUSE` |
| | `torrents.resume` | `TORRENTS_RESUME` |
| | `torrents.start` | `TORRENTS_START` |
| | `torrents.stop` | `TORRENTS_STOP` |
| | `torrents.delete` | `TORRENTS_DELETE` |
| | `torrents.delete_data` | `TORRENTS_DELETE_DATA` |
| | `torrents.recheck` | `TORRENTS_RECHECK` |
| | `torrents.manage_trackers` | `TORRENTS_MANAGE_TRACKERS` |
| | `torrents.manage_files` | `TORRENTS_MANAGE_FILES` |
| | `torrents.manage_limits` | `TORRENTS_MANAGE_LIMITS` |
| | `torrents.move` | `TORRENTS_MOVE` |
| | `torrents.rename` | `TORRENTS_RENAME` |
| **Categories & tags** | `categories.manage` | `CATEGORIES_MANAGE` |
| | `tags.manage` | `TAGS_MANAGE` |
| **RSS & automation** | `rss.view` | `RSS_VIEW` |
| | `rss.manage` | `RSS_MANAGE` |
| | `automation.view` | `AUTOMATION_VIEW` |
| | `automation.manage` | `AUTOMATION_MANAGE` |
| **File manager** | `files.view` | `FILES_VIEW` |
| | `files.manage` | `FILES_MANAGE` (legacy umbrella; still used by the media renamer) |
| | `files.preview` | `FILES_PREVIEW` |
| | `files.download` | `FILES_DOWNLOAD` |
| | `files.create_folder` | `FILES_CREATE_FOLDER` |
| | `files.rename` | `FILES_RENAME` |
| | `files.move` | `FILES_MOVE` |
| | `files.copy` | `FILES_COPY` |
| | `files.delete` | `FILES_DELETE` |
| | `files.bulk_actions` | `FILES_BULK_ACTIONS` |
| | `files.cleanup` | `FILES_CLEANUP` |
| **Administration** | `settings.view` | `SETTINGS_VIEW` |
| | `settings.manage` | `SETTINGS_MANAGE` |
| | `users.view` | `USERS_VIEW` |
| | `users.manage` | `USERS_MANAGE` |
| | `roles.manage` | `ROLES_MANAGE` |
| | `audit.view` | `AUDIT_VIEW` |
| | `system.view` | `SYSTEM_VIEW` |
| | `system.manage` | `SYSTEM_MANAGE` |
| | `apikeys.manage` | `APIKEYS_MANAGE` |
| | `engines.manage` | `ENGINES_MANAGE` |
| | `notifications.manage` | `NOTIFICATIONS_MANAGE` |

### System roles

| Role | Permissions |
|------|-------------|
| `SUPER_ADMIN` | **All** permissions; additionally bypasses granular checks in the guard |
| `ADMINISTRATOR` | All permissions **except** `system.manage` |
| `POWER_USER` | All torrent actions + categories/tags + RSS + automation + **all `files.*`** (full file management incl. delete/bulk/cleanup) + `system.view` (no admin/user/role management) |
| `USER` | View/add torrents, basic state changes (pause/resume/start/stop), categories/tags, `rss.view`, and read-only files (`files.view`/`preview`/`download`) |
| `READ_ONLY` | `torrents.view`, `rss.view`, `automation.view`, read-only files (`files.view`/`preview`/`download`), `system.view` |

The exact mappings live in `ROLE_PERMISSIONS` and are applied verbatim by the
seed. Because the same catalog drives the frontend, the UI can hide actions a
user can't perform — but the server-side guard is the actual enforcement point.

## Rate limiting

`@nestjs/throttler` protects sensitive endpoints. The auth endpoints carry
explicit limits:

| Endpoint | Limit |
|----------|-------|
| `POST /api/auth/login` | 5 requests / 60 s |
| `POST /api/auth/refresh` | 20 requests / 60 s |

These throttle brute-force credential attacks and refresh abuse. The 2FA
second step is submitted to the same `POST /api/auth/login` endpoint, so the
5-per-minute limit also bounds TOTP/recovery-code guessing.

## HTTP hardening (Helmet)

[Helmet](https://helmetjs.github.io/) is part of the stack
(`helmet@^8`) to set secure HTTP response headers (HSTS, `X-Content-Type-Options`,
frame/cross-origin policies, etc.). CORS is restricted to the configured
`CORS_ORIGIN`.

## Input validation

All request bodies are typed DTOs validated with `class-validator`
(`class-transformer` for transformation). Examples: `username` is length-capped,
`newPassword` requires ≥ 10 characters, engine `kind`/`mode` are constrained to
known enums, numeric limits must be `≥ 0`, and bulk actions are restricted to an
allow-list. Invalid payloads are rejected with `400` before reaching any service.

## Audit logging

Security-relevant and **destructive** actions are recorded by `AuditService` into
the `audit_logs` table, capturing: the acting user, `action`, `objectType`/
`objectId`, `result` (`success`/`failure`), `ipAddress`, `userAgent`, optional
`metadata`, and a timestamp. Examples that are audited:

- Authentication: `auth.login` (both success **and** failure, the latter with the
  attempted username — a pending-2FA challenge is **not** counted as a failure),
  `auth.change_password`.
- Account & 2FA: `account.password_changed`, `account.2fa_enabled`,
  `account.2fa_disabled`.
- Torrent lifecycle: `torrents.add`, `torrents.start/stop/pause/resume`,
  `torrents.recheck`, `torrents.delete`, `torrents.delete_data`, `torrents.move`,
  rate/file/tracker mutations, and `torrents.bulk.<action>` (with a count).

Audit writes are best-effort and isolated — a logging failure never breaks or
leaks into the user request. Logs are queryable (with the `audit.view`
permission) at `GET /api/audit` and surfaced on the dashboard activity feed.

## File-path validation

The file manager operates only within an explicit allow-list of root directories
configured via `FILE_MANAGER_ROOTS` (comma-separated, default `/downloads`),
parsed in `config/configuration.ts`. Every operation routes through the
`PathSafety` helper (`modules/files/path-safety.ts`), which enforces:

- **Traversal & absolute-escape:** `../` segments are collapsed and a leading
  slash is stripped + re-based under a root, so `/etc/shadow` and
  `movies/../../etc` can never reach a real system path.
- **Null bytes & bad names:** paths containing NUL are rejected; new
  file/folder names may not contain `/`, `\`, NUL, `.`/`..`, or exceed 255 chars.
- **Symlink escape:** `resolveExisting` resolves the real path (`fs.realpath`)
  of both the target and the roots and re-checks containment, so a symlink
  pointing outside the roots is rejected.
- **Destructive-target guards (`assertDeletable`):** delete/rename/move of a
  **configured root**, the **filesystem root**, or a known **system directory**
  (`/etc`, `/usr`, `/var`, …) is always refused.
- **Containment for derived paths (`ensureContained`):** paths computed from an
  already-resolved absolute path (e.g. a rename sibling) are validated for
  root-containment without re-basing.

**Default Root Path (two-layer boundary).** `FILE_MANAGER_ROOTS` is the
**hard, ops-controlled** outer boundary — set in the deployment environment,
never widened at runtime. On top of it, an admin with the
`settings.manage_root_path` permission can set a **Default Root Path** (setting
`fileManager.defaultRootPath`, changed only via `PUT /api/files/root`) to
**narrow** browsing to a subtree. `FilePathService` rebuilds `PathSafety` from
it, so every containment check (browse, create-folder, move, …) honours the
narrowed root. The endpoint validates the path is absolute, **inside**
`FILE_MANAGER_ROOTS`, not a system directory, existing, and readable; a value
outside the hard roots is ignored (falls back to the env root). Changes are
audited (`settings.update_root_path`, success + failure). The directory picker
in the UI only offers in-root paths, and the server still validates every
submitted path on use — the picker is a convenience, not the security boundary.
The generic settings routes refuse `fileManager.defaultRootPath` so validation
can't be bypassed.

Deletes are **soft by default** — items move into a `.ultratorrent-trash`
directory inside their own storage root (recorded as a `TrashItem`) and can be
restored or purged; `permanent: true` is required to delete irreversibly. The
trash directory is hidden from browse listings and is the only location the
trash-purge/empty operations will remove from. The Cleanup Wizard never deletes
automatically: `cleanup-preview` is read-only and `cleanup-execute` removes only
explicitly-selected candidate paths, confined to the scanned subtree. Keep
`FILE_MANAGER_ROOTS` as narrow as possible and matching the directories your
engine actually writes to.

## Secrets management

- All secrets (JWT signing keys, database URL, Redis, admin bootstrap password)
  come from **environment variables** — never hard-coded for real deployments.
- Engine connection configs may contain secrets; the engine **list endpoint
  strips them**, returning only non-sensitive fields (`id`, `name`, `kind`,
  `isDefault`, `isEnabled`, `mode`). The schema notes secrets are stored
  encrypted at rest.
- Refresh tokens are stored hashed (SHA-256); passwords are stored hashed
  (Argon2id); 2FA recovery codes are stored hashed (SHA-256). None is ever logged.
- **TOTP secrets** are encrypted at rest with AES-256-GCM using `ENCRYPTION_KEY`
  (generate with `openssl rand -base64 48`). If unset it falls back to
  `JWT_ACCESS_SECRET`; set a dedicated key in production. **Rotating this key
  invalidates existing TOTP secrets**, so affected users must re-enroll.
- **Production boot guard:** when `NODE_ENV=production`, the backend **refuses
  to start** if `JWT_ACCESS_SECRET` or `ENCRYPTION_KEY` is unset, matches a known
  `dev-*`/`change-me` default, is shorter than 32 chars, or if the two are
  identical — closing the "forgot to set a secret → forgeable SUPER_ADMIN token"
  hole. Docker Compose likewise refuses to start without `POSTGRES_PASSWORD` and
  `ADMIN_PASSWORD` (no insecure defaults).

## UPLM licensing (Enterprise overlay)

Enterprise licensing is handled by **UPLM** (the external authority) in the
private overlay; the public Core has no UPLM dependency. The security model
(full detail in [UPLM.md](UPLM.md)):

- **Ed25519** signatures over **canonical JSON** for both the signed module
  catalog and UPLM entitlements. A single canonicalization routine is shared by
  signer and verifier so they cannot drift.
- **Two key pairs**: a module-signing pair (build box signs the catalog, UPLM
  verifies) and an entitlement-signing pair (UPLM signs entitlements, every
  instance verifies). **Private keys are never committed** — `keys/`, `*.pem`,
  and `*.key` are gitignored; keys come from env/files at deploy time.
- **Key rotation** via a `keyId` on every signed document; multiple trusted
  UPLM public keys may be configured simultaneously.
- **Fail-closed verification**: an entitlement is rejected (never throws) unless
  it is signed by a *trusted* key, the signature verifies, the schema matches,
  it grants ≥1 module, it is unexpired, and any platform binding matches. With
  no valid entitlement, every Premium/Enterprise module stays **locked**; Core
  and Community run with no license.
- **Authoritative backend gating**: licensing is enforced by the registry +
  `ModuleGuard`, never by the frontend. Unsigned or unknown-key entitlements are
  never trusted.
- **Audit**: every `license.uploaded/verified/rejected/expired`,
  `module.unlocked`, and module-export event is recorded.

## Node Agent

The Node Agent prepares every install for central management without weakening a
standalone deployment (full detail in [NODE_AGENT.md](NODE_AGENT.md)):

- **Stable random identity**: `nodeId` is a random opaque id and `installId` a
  UUID, both minted once and stable across restarts/upgrades.
- **No raw tokens**: a Central-issued node token is stored only as a SHA-256
  hash (`nodeTokenHash`); the raw token is never persisted. Other Central
  secrets use `SecretCipher` (AES-256-GCM).
- **No arbitrary execution**: remote commands are restricted to an explicit
  allow-list of types; unknown types are rejected, never run. Core never shells
  out. Proprietary command execution lives in the Enterprise overlay and is
  audited.
- **RBAC**: every Node Agent action requires a `node_agent.*` permission;
  backend enforcement is authoritative.
- **Optional, fail-safe transport**: the Central transport is optional (Core
  ships a no-op). Transport failures never break local health/heartbeat
  recording, and registration in Community returns a clear "unavailable" result
  instead of erroring.
- **Audited**: registration, unregistration, and command execution are written
  to the audit log and to `node_agent_events`.

## Fleet Management (Enterprise overlay)

Central-side fleet control (full detail in
[FLEET_MANAGEMENT.md](FLEET_MANAGEMENT.md)) is gated and safe by construction:

- **Triple-gated**: every Fleet route is `@RequiresModule('fleet_management')` +
  `ModuleGuard` (so it 403s unless the module is enabled — which needs a UPLM
  entitlement) **and** RBAC (`fleet.*`). `FleetCommandService` re-checks
  `licensed` as defence in depth.
- **No raw credentials**: enrollment tokens and node tokens are stored only as
  SHA-256 hashes (`FleetNodeCredential`); the raw token is returned exactly once
  at creation/enrollment.
- **Approved commands only**: Central may issue only the Node Agent allow-list of
  command types; unknown types are rejected and recorded. No arbitrary shell
  execution; issuance requires the node to be active and the module licensed.
- **Audited**: node create/update/delete, enrollment, command issuance, group and
  policy changes are written to the audit log and to `fleet_node_audit_events`.
- **Scaffolded transport**: the node-facing `enroll`/`heartbeat` endpoints are a
  clearly-marked scaffold authenticated by node tokens, to be replaced by a
  hardened mTLS Central transport. Full remote update orchestration is out of
  scope for this milestone.

## Customers, Provisioning & Billing (Enterprise overlays)

The managed-seedbox business modules (full detail in
[PROVISIONING.md](PROVISIONING.md) and [BILLING.md](BILLING.md)) are each
module-gated (`@RequiresModule` + `ModuleGuard`, i.e. UPLM) + RBAC:

- **Credentials encrypted at rest**: cloud-provider API keys
  (`ProvisioningProviderCredential`) and billing-provider secrets
  (`BillingProviderConfig`) are encrypted with **SecretCipher (AES-256-GCM)**.
  Raw secrets are never stored plaintext, never returned by the API (list
  results are masked), and never logged — verified against the DB and logs.
- **No hardcoded cloud credentials**: the Vultr scaffold makes no live/billable
  call without a configured key **and** explicit `liveMode`; provisioning jobs
  are never auto-executed.
- **Dangerous actions are permission-scoped + audited**: creating a server
  requires `provisioning.create_server`, destroying requires
  `provisioning.destroy_server`; billing `suspend`/`resume` require their own
  permissions and are audited and event-logged.
- **Minimal PII**: customers store only name + optional email/company.
- **Webhooks isolated**: inbound billing webhooks are on a separate,
  non-user-authed controller, signature-verified per provider (scaffold).

## Premium modules (Milestone 6)

The premium overlays are each module-gated (UPLM) + RBAC. Notable controls:

- **Media Renamer Pro** ([MEDIA_RENAMER.md](MEDIA_RENAMER.md)): every source and
  destination is **path-traversal-checked** with Core's `PathSafety` (in
  addition to per-segment template sanitisation). **Seeding is preserved** by
  default (hardlink/symlink/copy never remove the original); only the explicit
  `rename_*` modes relocate originals, behind `media_renamer.execute`. There is
  **no delete mode**. Execute and rollback are audited.
- **Library Awareness** ([MEDIA_SERVERS.md](MEDIA_SERVERS.md)): media-server API
  tokens are **encrypted at rest** (`SecretCipher`), never returned or logged; no
  hardcoded credentials.
- **Release Scoring** is a pure function (no IO, no secrets). **Analytics** is
  read-only over existing data.
- Dangerous renamer actions (`execute`, `rollback`) and multi-server/media-server
  mutations require their own granular permissions; backend enforcement is
  authoritative.
- **Media Acquisition Intelligence** ([MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md)):
  **never performs file operations** — it only records explainable decisions and
  *pending* recommendations; replacement/upgrade is recommended, never executed.
  Releases requiring approval are **not** auto-downloaded. `approve`/`reject`/
  `override` are separate permissions (`override` is the stronger one); every
  decision and approval is audited and carries a full decision trace.

## Engine control surface

The rTorrent SCGI/XML-RPC interface is **unauthenticated and gives full control**
of the client (including the ability to execute commands such as `rm` during
delete-with-data). Treat it as a privileged internal endpoint:

- Bind it to `127.0.0.1` or a Unix socket; never expose it to the network.
- Only the UltraTorrent backend should be able to reach it — all user access goes
  through the authenticated, permission-checked, audited API.

**Torrent add & save paths.** Adding a torrent by URL is SSRF-guarded
(`common/ssrf.ts`): only `http(s)` schemes, hosts resolving to loopback/private/
link-local/CGNAT/metadata addresses are blocked, redirects are refused, and the
body is size-capped (20 MB, streamed). `savePath`/`category`/move destinations
are validated against `FILE_MANAGER_ROOTS` and rejected if they contain quote or
control characters (which could otherwise break out of the quoted rTorrent
command string). Bulk actions (`/torrents/bulk`) enforce the **same permission
as their dedicated route** per action (e.g. `removeData` requires
`torrents.delete_data`), so a viewer cannot trigger destructive operations.

**Realtime (WebSocket).** The `/ws` gateway authenticates the JWT on handshake
and joins each socket only to `perm:<key>` rooms for the **view permissions it
holds** (`torrents.view`/`files.view`/`node_agent.view`; SUPER_ADMIN all). Live
events are emitted only to the matching room, so a user never receives realtime
data they could not read over REST.

**Privilege-escalation guards.** Only a SUPER_ADMIN may grant the SUPER_ADMIN
role, and no user may edit their own roles (`users.manage` alone cannot
self-promote). Deactivating a user revokes its refresh tokens, and token refresh
is rejected for a disabled account.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue
for a vulnerability.

1. Email the maintainers (e.g. `security@your-domain.example`) or use GitHub's
   private security advisory feature for this repository.
2. Include a description, affected versions/components, reproduction steps, and
   impact.
3. Allow reasonable time for a fix before any public disclosure. We aim to
   acknowledge reports promptly and will credit reporters who wish to be named.

> Update the contact address above to your project's real security contact before
> publishing.
</content>
