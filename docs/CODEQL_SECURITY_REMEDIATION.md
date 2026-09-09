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

| Severity | Baseline | Phase 1 | Paths | Regex | Prop. inj. | TOCTOU | Escaping |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Critical | 8 | **4** (by-design) | 4 | 4 | 4 | 4 | 4 |
| High | 103 | 101 | 101 | 98 | 92 | 92 | **90** |
| Medium | 13 | 13 | 13 | 13 | 13 | 13 | 13 |
| Quality-only | 39 | 39 | 39 | 39 | 39 | 39 | 39 |
| **Total open** | **163** | 157 | 157 | 154 | 148 | 148 | **146** |

The TOCTOU column is flat, and within it `js/file-system-race` went 4 → **5**.
Two real races were closed and one new alert was raised on the safer code. The
count is not the measure.

**15 alerts closed as `fixed` across all phases**, and a further ~59 carry a
documented false-positive disposition backed by tests.

Phase 2 closed no alerts, by design — see SECURITY-05. Of the 101 High, **56 now
carry a documented false-positive disposition** backed by tests, leaving 45
genuinely unexamined.

Post-Phase-1 counts are from a real CodeQL run against `210f3911`, not an
estimate. Six alerts closed as `fixed`: three type-confusion, two
request-forgery, and one polynomial-redos pair closed incidentally.

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

**Verification status — rescanned.** CodeQL ran against `210f3911` and closed
**#184 (media-server) and #138 (Telegram)** as `fixed`. Three remain open by
design — #11 qBittorrent, #12 Prowlarr, #139 Discord — plus **#198**, a new alert
number for the same media-server call site after the line moved.

That was the predicted outcome and it is not a failure. CodeQL reports a dataflow
from stored configuration to a `fetch` destination, and that dataflow is real: an
administrator genuinely does choose where these providers live. The alert
describes the architecture correctly; the security question is whether the
boundary around it is right, and that is what the validation, the redirect
refusal and the structural path join answer. Their disposition is
**"false positive, documented"**, not "fixed", and they should be dismissed in
the GitHub UI as *used in tests / won't fix — by design* with a link to this
section rather than left to accumulate as unexplained noise.

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

**Verification status — rescanned and closed.** CodeQL ran against `210f3911`
and closed **all three** (#179, #180, #181) as `fixed`.

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

## High findings

### SECURITY-05 — `js/path-injection` (68 alerts)

**Distribution.** `modules/files` 39 · `modules/media` 16 ·
`modules/media-intake` 12 · `modules/torrents` 1.

**The count overstates the problem, and it is worth saying how.** These are not
68 distinct call paths. `file-fs.util.ts` (13 alerts) is a thin wrapper over
`fs/promises` taking already-resolved absolute paths, and `files.service.ts`
(15 alerts) is its main caller — CodeQL reports the same flows again one frame
deeper. `file-path.service.ts` (6) and `path-safety.ts` (1) are the containment
utilities themselves. Roughly a dozen real call paths generate the 68.

**Security analysis.** A mature containment model already exists in
`modules/files/path-safety.ts`: `resolveLogical` normalises and asserts the
result sits inside a configured root; `resolveExisting` additionally resolves
symlinks with `realpath` and re-checks containment against the resolved roots;
`assertDeletable` refuses a configured root, the filesystem root and a list of
system directories. Containment is tested as `target === root ||
target.startsWith(root + path.sep)` — the trailing separator being what stops
`/srv/mediaXXX` passing as `/srv/media`.

Every flagged sink outside `media-intake` was traced and reaches the filesystem
through one of those gates, or through `FilePathService.assertWithinHardRoots`
in the media modules. CodeQL does not recognise a `startsWith(root + sep)` check
as a sanitizer, so it reports the flow regardless.

**That claim is now tested rather than asserted.** 68 alerts resting on "the
gate is sound" deserved evidence, so
`modules/files/path-safety-adversarial.spec.ts` adds 43 cases beyond the existing
`path-safety.spec.ts` and `path-safety-symlink.spec.ts`: percent- and
double-percent-encoded traversal, overlong UTF-8 (`..%c0%af`), dot-sequence
tricks (`....//`, `..;/`), Windows separators and UNC paths on POSIX, absolute
and multi-slash paths, Unicode separator lookalikes (`\u2044`, fullwidth stops)
and zero-width characters, null bytes, a 5 000-segment traversal, degenerate
inputs, and the multi-root form where absolute paths are accepted on the wire.
Every case ends contained or refused. **No hole was found.**

**Disposition: documented false positives**, for the 56 alerts covered by those
gates. They should be dismissed in the GitHub UI as *won't fix — by design*,
citing this section, rather than left to accumulate.

**Verification — rescanned, and the count did not move.** CodeQL ran against
`7d16f6bc`: `js/path-injection` remains at **68**, including the 12 in
`storage-capability-detector`. That is the correct outcome and worth stating
plainly rather than dressing up. The fix there is a *shape* check — the root must
be absolute — not a containment sanitizer, and the dataflow from storage-profile
configuration to a filesystem call still exists because probing a configured root
is the entire purpose of the service. Nothing in this group can be closed by
writing better code; these alerts close by being dismissed with a reason, or not
at all.

What the work delivered was therefore not a lower number: it was one real bug
fixed, and 56 alerts moved from *unexamined* to *false positive with adversarial
tests behind the claim*. The distinction matters, because an unexamined alert and
a dismissed one look identical in a backlog and are not the same thing.

### SECURITY-05b — `storage-capability-detector` (12 alerts) — genuine gap, fixed

The exception, and the reason the group was worth auditing rather than dismissing
wholesale. `StorageCapabilityDetector.probe()` had **no path validation at all**:
it built `join(targetRoot, PROBE_DIR)` and then created a scratch directory and
removed it **recursively**.

`PROBE_DIR` is a constant, so it cannot traverse, and the roots are storage-profile
configuration rather than request input — which is why this is a shape check and
not a containment gate. The specific hazard is narrower and easy to miss:
`join('', '.ultratorrent-probe')` yields a **relative** path, and a relative path
resolves against the process working directory. A blank or whitespace root would
therefore have created and then recursively deleted a directory inside the
application's own tree — succeeding silently, so nothing downstream would have
caught it.

**Remediation.** Both roots must be non-empty, null-byte-free and absolute before
anything touches the filesystem. A failure is refused and recorded with the
reason, rather than defaulted: a probe that cannot say where it is running has
nothing useful to report. 10 tests in
`storage-capability-roots.spec.ts` cover empty, blank and relative roots on both
sides, assert the error names the specific problem, and assert that two absolute
roots still proceed to measurement.

### SECURITY-03 — `js/regex-injection` (2 alerts) — one genuine bug

| Alert | Location |
| --- | --- |
| #193 | `media-discovery/acquisition-template.service.ts:251` |
| #14 | `rss/match-engine.ts:397` |

**#193 is a real defect, found by following the alert rather than dismissing it.**
CodeQL flags the `new RegExp(c.pattern)` in `assertCandidate`, which is only a
validity check — the compiled expression is discarded. That site is benign. But
reading the file to establish that led to `patternFor`, thirty lines away:

```ts
return candidate.pattern?.trim() ? candidate.pattern : title;   // before
```

When a ladder rung has `matchType: 'regex'` and no pattern, the **show title is
substituted** — and the title comes from TMDB or TVmaze. Two consequences:

- **Correctness.** `S.W.A.T. Exiles` becomes the pattern `S.W.A.T. Exiles`, in
  which every `.` matches any character, so the rung matches releases it should
  not. Not hypothetical: that show is in the live catalogue.
- **ReDoS.** A provider title containing nested quantifiers becomes an expression
  evaluated against every item in every polled feed.

**Remediation.** `common/escape-regex.ts` — one function, single-pass escaping
rather than a chain of `replace` calls, which is how a backslash gets escaped
twice. Applied in `patternFor` for the `regex` type only: `wildcard` does its own
escaping and deliberately keeps `*` and `?` meaningful, and the smart types match
on tokens rather than an expression.

**#14 is the operator's own regular expression** — writing one is the point of
that match type — so injection is not the finding. The subject is not the
operator's, though: it arrives from a feed. See SECURITY-04.

### SECURITY-04 — `js/polynomial-redos` (9 alerts)

**Root cause across all of them:** an unbounded quantifier meeting an unbounded
subject. Three were worth fixing on exploitability; the rest run on short
administrative configuration.

| Fix | Why |
| --- | --- |
| `media-identity.ts` — `[\s._-]*` → `[\s._-]{0,32}`, `[\s._-]+` → `{1,32}` | Runs on every provider title, RSS rule name and library item. The pattern is unanchored at the start, so a title made of separators cost O(n²). No real title puts 32 separators before its year. |
| `media-renamer.ts` `stripProviderIdTag` — bounded `[^}\]]{0,128}` and `\s{0,8}` | Applied to names derived from torrents and folders — untrusted text. A real provider-id tag is a dozen characters. |
| `match-engine.ts` — subject capped at 1 024 characters before an operator regex runs | The pattern is the operator's; the release name is a third party's. Backtracking scales with input length, so capping the subject makes even a careless expression return. Truncation cannot turn a non-match into a match. |

Not changed: `sanitizeSegment` (3 alerts), `discovery-template.service.ts`
(a `pathTemplate`, administrative and short) and `newsletter-image.service.ts`
(a configured base URL). Bounded inputs from configuration rather than from a
feed; recorded here so the decision is visible rather than implied.

**Tests.** `common/regex-safety.spec.ts` — 35 cases. Escaping is asserted to make
a literal match itself and to stop `.` matching an arbitrary character, with a
single-pass backslash check. Timing assertions run adversarial inputs (50 000
separators, 100 000 characters, unterminated tags, bracket runs) against a
deliberately loose 400 ms budget, so they catch quadratic behaviour without
becoming flaky. Six cases assert that bounding the separator run did not change
any real canonicalisation — including `Blade Runner 2049`, `1923` and `2012`,
where the year must NOT be stripped. A further 5 in
`acquisition-template.spec.ts` cover the injection fix at its call site.

**Verification — rescanned.** CodeQL ran against `b52c016e`.
`js/polynomial-redos` went **9 → 6**: both `media-identity` alerts (#195, #196)
closed as `fixed`, and one of the `media-renamer` pair (#110) with them.

`js/regex-injection` remains at 2, as predicted. Both sites still construct a
`RegExp` from stored input — which is what the rule detects and what the feature
requires. The escaping changes what the pattern *means*, not whether a pattern is
built, so the alert is unaffected by the fix and the disposition is
**false positive, documented**. That the alert did not move is precisely why it
was worth reading the file rather than trusting the alert count: the genuine bug
it led to was thirty lines from the line it pointed at, and closing the alert was
never going to be the signal.

### SECURITY-02b — `js/remote-property-injection` (7 alerts)

All seven report the same thing — *a property name to write to depends on a
user-provided value* — and all seven are the same shape: a map whose **keys**
come from outside is copied into a fresh object.

**Why the key matters.** `JSON.parse` returns `__proto__` as a real own
property, so it survives into `Object.entries`. Assigning it to an object
literal does not store an entry: it invokes the inherited setter and **replaces
that object's prototype**. The copy silently loses the key and gains whatever the
attacker's object carried, so a later lookup can resolve to something nobody
stored.

**The bencode parser is the one that deserved the attention.**
`infrastructure/rtorrent/bencode.ts` decodes `.torrent` files — downloaded from
trackers and indexers, entirely untrusted — and bencode lets a dict name any key.
Verified empirically rather than reasoned about: assigning `__proto__` on the
plain object *does* hijack that object's prototype, and a later `root['info']`
*can* resolve through it.

Whether that is exploitable today turns on an accident. `readDict` stores a
wrapper (`{ value, start, end }`), so the hijacked prototype carries no `info`
key and `infoHashFromTorrent` throws as it should. **No forgery is achievable.**
But that is a property of this file's internals rather than one anybody chose,
and `infoHashFromTorrent` computes a SHA-1 over `data.subarray(info.start,
info.end)` — had the prototype been able to supply an `info`, an attacker would
have chosen the byte range the hash is computed over.

**Remediation.** `Object.create(null)` for the bencode dict: `__proto__` becomes
an ordinary own key, no lookup can inherit, and nothing legitimate changes since
the map is only ever read by key.

The other six are configuration copies — engine secrets, media-server
integration (×3), the watchlist and subtitle provider settings. Those objects are
handed to Prisma as JSON columns, spread, and passed to code that may reasonably
call a method on them, so a null prototype is the wrong tool. They use
`common/safe-object.ts` instead, which drops `__proto__`, `constructor` and
`prototype` at the copy. Nothing legitimate is lost: no engine, media server or
subtitle provider has a setting by those names, and a request sending one is not
configuring anything.

**Tests.** `common/safe-object.spec.ts`, 13 cases: each refused key, ordinary
settings preserved, the target prototype asserted intact after a hostile copy,
engine encryption still working on the real secret beside the hostile key, and
the bencode parser exercised through its public `infoHashFromTorrent` — a hostile
key beside a real `info` yields the same hash as the clean torrent, and a torrent
declaring no `info` is refused rather than satisfied by an inherited lookup.

**Verification — rescanned.** CodeQL ran against `a9ea99c4`:
`js/remote-property-injection` went **7 → 1**. All six configuration copies
closed as `fixed`; only `bencode.ts` remains, because `out[key] = …` is still a
dynamic write and `Object.create(null)` removes the *danger* rather than the
dynamism. That one is a documented false positive.

### SECURITY-05c — `js/file-system-race` (4 alerts)

| Alert | Location | Disposition |
| --- | --- | --- |
| #171 | `modules/files/files.service.ts:269` | **Fixed** |
| #79 | `modules/media/media-artwork.service.ts:492` | **Fixed** |
| #174 | `common/route-shadowing.spec.ts:26` | False positive — test code |
| #80 | `website/scripts/generate-screenshot-placeholders.mjs:136` | False positive — docs build script |

**Two are not production code.** A spec file and a script that runs on a
developer's machine at docs-build time; neither is reachable by anyone. They are
recorded rather than edited, because changing test or build code to satisfy a
scanner is how a suite stops describing the system.

**The gap the path work did not cover.** SECURITY-05 established that every
filesystem sink resolves against an asserted root. That check is against a
**path** — resolved, symlink-followed, asserted inside a root — and a path is a
name, not a thing. Between the check and the use, what the name refers to can be
replaced. Anyone able to write into a media directory can do it, and that
includes a torrent unpacking into one.

`FilesService.preview` did `stat(target)` and then `open(target)`, resolving the
name twice. It now compares the opened inode (`fstat` on the handle) against the
one that was checked, and refuses a mismatch rather than re-checking: something
moved underneath the read, and the honest answer is to stop.

`MediaArtworkService` did `stat(cachePath)` then `createReadStream(cachePath)` —
the size describing one file while the bytes came from another, which is a
mismatched `Content-Length` at best and a swapped file served as `image/webp` at
worst. It opens once and streams from the handle, closing it on both `close` and
`error` so a leaked descriptor per thumbnail cannot exhaust the process.

**Tests.** `preview-toctou.spec.ts` uses a real temporary directory and a real
swap rather than a mocked `fs`, because the property under test is what the
filesystem does with names and inodes — a mock would prove nothing. **Verified to
fail without the fix** (1 of 4 failing when the inode check is removed), which is
the only way to know the test is describing the bug. It also asserts that a
symlink pointing outside the root is still refused by containment, so the two
mechanisms stay visibly distinct: containment handles the name, the inode check
handles the swap.

**Verification — rescanned, and the count went UP.** CodeQL ran against
`a1e427bb`: `js/file-system-race` is **4 → 5**.

Worth setting out exactly, because it is the sharpest example in this backlog of
the count being the wrong measure.

- `files.service.ts:269` still reports. The rule sees a `stat`-then-`open` pair,
  which is still there; what changed is that the second operation now *verifies*
  it got the inode the first one described. The rule models the pattern, not
  whether the pattern is guarded.
- `media-artwork.service.ts` now has **two** alerts where it had one. The
  pre-existing pair is the cache-freshness `stat` at 484 followed by
  `writeFile`; my `open` at 508 is a second use after that same check, so it is
  reported as well.

The code is safer — proven by a test that fails without the fix — and the
dashboard is one worse. Both statements are true, and only the first one is about
security.

The remaining artwork pair was left deliberately. It is a check-then-act on a
thumbnail cache the server itself writes, inside the hard roots, where the
"attacker" would already need write access to a directory we own. Restructuring
the regeneration path to hold a single handle across freshness-check, write and
read would add real complexity to satisfy a rule that is modelling a shape rather
than a risk.

### SECURITY-06 — escaping and sanitization (5 alerts)

| Alert | Location | Disposition |
| --- | --- | --- |
| #192, #191 | `tvmaze-discovery.provider.ts:313` | **Fixed** — two defects on one line |
| #15 | `media-server-provider.ts:170` | **Fixed** |
| #164 | `frontend lib/subtitles.ts:90` | **Fixed** |
| #17 | `website/scripts/generate-reference.mjs:565` | False positive — docs build script |

**One root cause: escaping written by hand, in the wrong order or in one pass.**

**Order.** `stripHtml` removed tags and *then* decoded entities. `&lt;script&gt;`
contains no literal `<`, so it survived the tag pass untouched — and the entity
pass immediately turned it into a real `<script>`. The function produced exactly
the markup its name promises to remove. `decodeXmlEntities` had the mirror image:
`&amp;` decoded **first**, so `&amp;lt;` became `&lt;` and was then decoded again
into `<`, a character the Plex attribute never contained.

**One pass.** `replace(/<[^>]*>/g, '')` deletes what it matches, and what remains
can be a tag that was not in the input: `<scr<script>ipt>` loses its inner tag
and becomes `<script>`. A single pass is not a fixpoint.

**Remediation.** `common/html-text.ts`: `stripTags` repeats until the string stops
changing, `decodeEntities` decodes `&amp;` **last**, and `htmlToText` composes
them strip → decode → strip, because decoding is what can produce a tag that was
not there. A literal `<` written as `&lt;` in prose is lost, which is the right
trade for a synopsis. Applied to TVmaze and Plex; the frontend cue stripper got
the same fixpoint treatment in place, since it cannot import backend code.

**A second bug, found by the test rather than the alert.** The adversarial timing
case on `stripCueMarkup` measured **496 ms for a 40 KB cue**. `[^>]*` scans from
every `<` to the end of the string when there is no `>` to find — quadratic, on
text arriving inside a downloaded subtitle file. The tag body is now bounded at
200 characters. CodeQL had not flagged this; writing a test that tried to break
the function did.

**Tests.** 23 in `common/html-text.spec.ts` and 8 added to the frontend
`subtitles.test.ts`. The strip tests assert the **property** — no `<…>` sequence
survives — rather than a particular residue: `<scr<script>ipt>` leaves `ipt>`,
which carries no `<` and is inert, and pinning the exact leftover would test the
regex's arithmetic instead of the guarantee. Ordinary summaries and cues are
asserted to still read as prose, including an ampersand written as `&amp;`.

**Verification — rescanned.** CodeQL ran against `08632198`: the escaping group
is **5 → 3**, and High is 92 → 90.

**All four production sites closed** — both TVmaze alerts, the Plex decoder and
the frontend cue stripper. Two new alerts took their place, on
`common/html-text.ts` and on its own **spec file**: the rule sees the single
`replace` inside `stripTags` and does not model the loop that repeats it to a
fixpoint. The utility is the fix for that rule's finding and is now reported by
it.

That is the fourth time in this backlog that a correct fix has left an alert
standing, and the second where it created one. Documented rather than worked
around: making the loop invisible to the rule would mean writing worse code.

### Remaining High groups (not yet remediated)

Audited and grouped by root cause; **no code changed yet**. Recorded here so the
next session starts from analysis rather than from the alert list.

| Group | Rule | Count | Initial read |
| --- | --- | --- | --- |
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

- **Four `js/request-forgery` alerts remain open by design** (#11, #12, #139,
  #198). They need dismissing in the GitHub UI with a reason, or they will sit in
  the backlog looking like unaddressed criticals. See SECURITY-01.
- **101 High findings are unaddressed**, including 68 path-injection alerts. This
  is the largest remaining body of security work. (Two `js/polynomial-redos`
  alerts closed incidentally with the Phase 1 changes.)
- **`npm run lint` does not run.** ESLint finds no configuration file anywhere in
  the repository, so the lint gate — including CI's `npm run lint --workspaces
  --if-present` — exits non-zero without linting anything. Pre-existing and
  unrelated to this remediation, but it means one of the four documented
  pre-release gates has not been enforcing anything.
- **No CodeQL rule was disabled, no alert dismissed, and no suppression comment
  added** in the course of this work.
