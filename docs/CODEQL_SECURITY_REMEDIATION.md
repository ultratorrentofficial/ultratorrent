# UltraTorrent CodeQL Security Remediation

Working document for the CodeQL backlog. It records what each finding actually
is, not merely that something was changed — a finding closed without an argument
is indistinguishable from one that was suppressed.

- [Baseline](#baseline)
- [Critical findings](#critical-findings)
- [False positives](#false-positives)
- [High findings](#high-findings-not-yet-remediated)
- [Remaining risks](#remaining-risks)

---

## Baseline

Taken from the GitHub code-scanning API on **2026-09-08**, against `main` at
`9549d3e2`, before any remediation.

| Severity | Count |
| --- | --- |
| Critical | 8 |
| High | 103 |
| Medium | 13 |
| Quality-only (no security severity) | 39 |
| **Total open** | **163** |

**Configuration:** `.github/workflows/codeql.yml`, language
`javascript-typescript`, query suite `security-and-quality`, on push to `main`,
on pull request, and weekly. The suite includes maintainability queries, which is
why 39 of the 163 carry no security severity at all — `js/unused-local-variable`
and similar. Those are not security work and are not counted as such here.

**Critical, by rule:**

| Rule | Count |
| --- | --- |
| `js/request-forgery` | 5 |
| `js/type-confusion-through-parameter-tampering` | 3 |

**High, by rule:** `js/path-injection` 68 · `js/polynomial-redos` 11 ·
`js/remote-property-injection` 7 · `js/file-system-race` 4 ·
`js/bad-tag-filter` 2 · `js/double-escaping` 2 ·
`js/incomplete-multi-character-sanitization` 2 · `js/regex-injection` 2 ·
`js/user-controlled-bypass` 2 · `js/incomplete-sanitization` 1 ·
`js/insecure-temporary-file` 1 · `js/loop-bound-injection` 1.

---

## Critical findings

### SECURITY-01 — `js/request-forgery` (5 alerts, one root cause)

| Alert | Location |
| --- | --- |
| #184 | `modules/media/media-server-provider.ts:248` |
| #139 | `infrastructure/discord/discord-transport.service.ts:46` |
| #138 | `infrastructure/telegram/telegram-transport.service.ts:193` |
| #12 | `modules/integrations/prowlarr/prowlarr.service.ts:340` |
| #11 | `infrastructure/qbittorrent/qbittorrent-client.ts:233` |

**Security analysis.** All five are the same shape: an operator-configured base
URL is concatenated with a fixed API path and fetched. CodeQL sees data flowing
from a request body into a `fetch` destination and reports request forgery.

The determining question is who controls the destination. These endpoints are set
through permission-gated admin surfaces (`MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS`
and equivalents) and persisted as configuration. That is a different trust
boundary from a URL arriving inside a request or a third party's JSON — and the
distinction matters in both directions, because UltraTorrent is self-hosted and
its providers legitimately live on private addresses. Blocking loopback and
RFC1918 here would break nearly every install and would not be a security
improvement.

**Exploitability.** An attacker who can already set a provider endpoint holds an
administrative permission; at that point the endpoint is the least of it. The
genuine gaps were narrower and are the ones that were fixed:

1. **No validation at all** on the qBittorrent and media-server endpoints — no
   scheme check, no rejection of embedded credentials. A `user:pass@host` URL
   forwards a secret on every call, and `http://real.example@evil.test` reads as
   one host to a person and another to a parser.
2. **Redirects were followed** by the media-server and Telegram clients.
   Validating a destination achieves little if the first response can move the
   request elsewhere.
3. **Unencoded interpolation** of the Telegram bot token and method into a URL
   path, where a `/` addresses a different Bot API method than the caller asked
   for.

**Remediation.** The correct model already existed in this repository, in
`prowlarr-url.ts`, and was private to one module. It is now
`common/provider-url.ts` and shared:

- `parseProviderBaseUrl` — `http`/`https` only, no embedded credentials, must
  parse and have a host. **Private, loopback and Docker-name hosts are allowed**,
  because that is the intended target. A scheme-less endpoint is normalised to
  `http://` rather than rejected, since `192.168.1.5:8080` is a configuration
  people really have and an upgrade must not invalidate it.
- `assertNotMetadata` — resolves at call time and refuses cloud instance
  metadata. Per call rather than per save, because DNS answers change.
- `joinProviderUrl` — sets the path component on a parsed base, so scheme, host
  and port always come from the configured endpoint. `//evil.example/x` becomes a
  path, not a new origin, which is what `new URL(path, base)` would have made it.

Applied to the qBittorrent client and the media-server provider; `redirect: 'error'`
added to the media-server and Telegram clients; Telegram path segments
percent-encoded. Prowlarr and Discord were already correct and are unchanged.

**Tests.** `common/provider-url.spec.ts`, 36 assertions. Half of them exist to
stop a future "SSRF fix" from breaking the product: Docker service names,
loopback, all three RFC1918 ranges, mDNS names, IPv6 loopback, reverse-proxy
subpaths and scheme-less endpoints are all asserted to keep working. The rest
assert the attacks fail — non-HTTP schemes, embedded credentials, and a property
test that no path value (`//evil.example`, absolute URLs, backslashes, `@`,
traversal) can move a request off the configured host or port.

**Verification status.** Fixed in code; tests pass. **Requires a GitHub CodeQL
rescan to confirm alert closure.** CodeQL may well continue to report some of
these, because the dataflow it describes is real — the destination genuinely does
derive from stored input. Where that happens the disposition is
"false positive, documented", not "fixed".

### SECURITY-02 — `js/type-confusion-through-parameter-tampering` (3 alerts)

Alerts #179, #180, #181 — `newsletter-unsubscribe.service.ts:71,75,87`.

**Security analysis.** The public unsubscribe endpoint reads `@Query('t')`
declared as `string`. Express parses `?t=a&t=b` into an array and `?t[x]=1` into
an object, and both reach code written for a string.

**Exploitability.** Traced in full. With an array, `token.lastIndexOf('.')`
resolves against array elements, and a crafted `?t=a&t=.` gets past the
`dot <= 0` guard into `Buffer.from(['a'], 'base64url')`, which coerces each
element through `Number` to zero bytes. The decoded value then contains no `:`
and parsing stops. **No forgery was achievable**, and the HMAC comparison is
constant-time and unaffected.

That is the finding worth stating precisely: the code failed closed *by
coincidence of coercion*, not by decision. It was safe as written and would not
necessarily have stayed safe through a refactor of the parsing beneath it. The
`esc()` helper would also have thrown a `TypeError` on an array, on a public
unauthenticated page, had a non-string ever reached the rendering branch.

**Remediation.** `common/query-param.ts` — `singleQueryParam` returns a string
only when the runtime value is one, applied in the controller. A malformed
parameter is treated as absent, so a link scanner sees the ordinary
"not a valid link" page rather than a stack trace. `parse`, `describe` and
`unsubscribe` now take `unknown` and check the type themselves, and `esc()`
refuses a non-string.

**Tests.** 14 added to `newsletter-unsubscribe.spec.ts`, covering ten tampered
shapes (arrays including the `['a','.']` case that got furthest, objects,
numbers, booleans, null, undefined) across `parse`, `describe` and `unsubscribe`,
asserting no recipient is ever removed — plus a test that a legitimately issued
token still round-trips and still unsubscribes.

**Verification status.** Fixed in code; tests pass. Requires a CodeQL rescan.

---

## False positives

### `js/request-forgery` #139 — Discord webhook

**Location:** `infrastructure/discord/discord-transport.service.ts:46`.
**Source:** an operator-supplied webhook URL. **Sink:** `fetch`.

`parseDiscordWebhook` already constrains the destination to a **hostname
allowlist**, requires `https`, rejects a non-443 port, rejects embedded
credentials, and requires the path to match the Discord webhook shape. The call
uses `redirect: 'error'`. There is no reachable destination outside Discord's own
hosts, so no attacker-controlled request is possible.

**Additional defensive value: none identified.** This is the strictest of the
five call sites and was left unchanged deliberately.

### `js/request-forgery` #12 — Prowlarr

**Location:** `modules/integrations/prowlarr/prowlarr.service.ts:340`.

Already validated by `parseProwlarrUrl` (http/https, no credentials), already
refuses redirects, already checks cloud metadata at call time via
`assertNotMetadata`. Private addresses are allowed by design — the bundled
Prowlarr is at `http://prowlarr:9696`.

**Defensive improvement applied:** none to behaviour; the model it pioneered was
promoted to `common/provider-url.ts` so other providers share it.

### `js/request-forgery` #138 — Telegram host

**Location:** `infrastructure/telegram/telegram-transport.service.ts:193`.

The host is the module constant `https://api.telegram.org`. No input reaches the
origin, so the request-forgery reading is a false positive.

**Defensive improvements applied anyway**, because the *path* was influenced by
input: both variable segments are now percent-encoded, and redirects are refused.

---

## High findings (not yet remediated)

Audited and grouped by root cause; **no code changed yet**. Recorded here so the
next session starts from analysis rather than from the alert list.

| Group | Rule | Count | Initial read |
| --- | --- | --- | --- |
| SECURITY-05 | `js/path-injection` | 68 | The dominant group by far. UltraTorrent legitimately manages library, staging, intake and artwork paths, and `docs/SECURITY.md` already documents a file-path validation model. The work is to determine which sinks resolve against an asserted root and which do not — not to add a blanket filter. |
| SECURITY-04 | `js/polynomial-redos` | 11 | Release-name and title parsing. Needs per-pattern analysis: bounded input, ambiguous quantifiers, and whether the input is attacker-controlled at all. |
| SECURITY-02b | `js/remote-property-injection` | 7 | Provider JSON indexed into objects. Same class as the type-confusion group already fixed. |
| SECURITY-05b | `js/file-system-race` | 4 | TOCTOU between a check and a filesystem operation. |
| SECURITY-06 | `js/double-escaping`, `js/incomplete-multi-character-sanitization`, `js/incomplete-sanitization` | 5 | Escaping that must be made context-specific rather than stacked. |
| SECURITY-03 | `js/regex-injection` | 2 | Untrusted values built into patterns; needs a tested escape utility rather than ad-hoc replaces. |
| — | `js/user-controlled-bypass`, `js/loop-bound-injection`, `js/bad-tag-filter`, `js/insecure-temporary-file` | 6 | Individually analysed. |

Medium: 10 of the 13 are GitHub Actions hygiene
(`actions/missing-workflow-permissions` 6, `actions/unpinned-tag` 4) — real, cheap
to fix, and independent of the application code.

---

## Remaining risks

- **No CodeQL rescan has run against these fixes.** No alert in this document is
  claimed closed. Some `js/request-forgery` alerts are expected to persist by
  design, with the disposition recorded above.
- **103 High findings are unaddressed**, including 68 path-injection alerts. This
  is the largest remaining body of security work.
- **`npm run lint` does not run.** ESLint finds no configuration file anywhere in
  the repository, so the lint gate — including CI's `npm run lint --workspaces
  --if-present` — exits non-zero without linting anything. Pre-existing and
  unrelated to this remediation, but it means one of the four documented
  pre-release gates has not been enforcing anything.
- **No CodeQL rule was disabled, no alert dismissed, and no suppression comment
  added** in the course of this work.
