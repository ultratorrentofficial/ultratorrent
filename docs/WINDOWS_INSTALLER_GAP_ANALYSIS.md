# Native Windows Installer — Phase 1 Audit & Gap Analysis

**Status:** Phase 1 complete. No code changed.
**Written against:** the tree at `1d9615e0` (v0.85.9), after installer Phases 1–3.
**Authoritative source:** [ARCHITECTURE.md](ARCHITECTURE.md), the installer as it
actually exists in `clients/installer/`, and the Compose stack. Everything below
was verified by reading and building the code, not inferred from prose.
**Companion:** [INSTALLER_GAP_ANALYSIS.md](INSTALLER_GAP_ANALYSIS.md) — the Linux
audit. Findings there are not repeated here.

---

## Status of these findings

Updated after Phase 2. The audit below is left as it was written — it is the
record of what was true at `1d9615e0` — and this table says what has changed
since.

Two things moved. The Linux installer went from Phase 3 to **Phase 8** while the
audit was being written, which resolves W7 by events rather than by argument:
there is now an executor, a config generator, storage preparation and engine
seeding. And **Windows was confirmed as a first-class target**, which settles
open question 1 and is why the executor interface must be designed with both
platforms in view rather than emerging from whichever ships first.

| Gap | Status after Phase 2 |
|---|---|
| **W1** Does not compile for Windows | **Closed.** `diskFree` split into `disk_unix.go` / `disk_windows.go`; the whole module builds, vets and tests for `GOOS=windows`, and `build.sh` produces `ultratorrent-install.exe` |
| **W2** Validation changes meaning with the build target | **Closed.** `Plan.TargetOS` is recorded and every host-path rule takes it as data — see `internal/plan/target.go` |
| **W3** Storage mechanism does not survive the port | **Open, and now enforced.** `config.CheckTarget` refuses to generate for a Windows target rather than emitting a Linux-only volume form. Still needs the experiment on a real Docker Desktop host |
| **W4** `PUID`/`PGID` meaningless on Docker Desktop | Open — belongs with the Windows wizard |
| **W5** `0600` protects nothing on Windows | Open — belongs with the first Windows file write |
| **W6** Detection acquires Linux facts, says Linux things | **Closed.** `host.Platform` seam; one `evaluate()`, two renderings. Windows rules are table-tested from the Linux build |
| **W7** No executor to sit beside | **Overtaken.** The Linux executor now exists (Phase 8) |
| **W8** `SupportedDistros` is the wrong shape for Windows | **Closed.** `ClassifyWindows` decides on edition and build; Server is recognised and deliberately unsupported |
| **W9** i18n scaffolded and empty | Open — still an empty directory, and the reason to do it before Windows strings multiply now applies to the strings Phase 2 added |
| **W10** Windows path hazards unhandled | **Closed.** Reserved device names, drive-relative paths, trailing dot/space, ADS colons, UNC advisories, and case-insensitive containment |
| **W11** Docker installation is a bigger promise on Windows | Open |
| **W12** Missing shared commands | Open — `status`, `doctor`, `reconfigure`, `upgrade` are still unbuilt on both platforms |


The brief asks for a Windows installer that reuses the shared `InstallationPlan`
core and isolates Windows behaviour behind a Windows executor. The audit's
headline is that **the reuse story is better than the brief assumes and the
sequencing story is worse**: the shared core is almost portable already, and the
Linux executor the Windows executor is supposed to sit beside does not exist yet.

---

## 1. What exists today

`clients/installer/` is a Go module (like `clients/console/`), outside the npm
workspace globs, at **3 124 lines** across three packages:

| Package | What it is | Portability |
|---|---|---|
| `internal/plan` | The typed `InstallationPlan`, defaults, validation, secret generation | **GOOS-neutral** except path semantics (§W2) and Linux-shaped defaults |
| `internal/host` | Read-only host detection → `Report` of `Finding`s | Model portable; **acquisition is Linux-only** (§W6) |
| `cmd/ultratorrent-install` | `plan`, `install --dry-run`, `version` | Portable |
| `internal/i18n` | **Empty directory** | Nothing to port (§W9) |

Three commands exist. `install` without `--dry-run`, `status`, `doctor`,
`reconfigure` and `upgrade` do not. The binary's own help says so: *"Not yet
implemented in this build: the interactive wizard and every command that changes
the system."*

**There is no executor of any kind, on any platform.** The brief's diagram —

```
                    Shared Installer Core
                           |
                     InstallationPlan
                           |
             +-------------+-------------+
      LinuxDockerExecutor         WindowsDockerExecutor
```

— describes a future state in which the left branch is also unbuilt. This is the
single most consequential finding for sequencing (§W7).

---

## 2. What ports better than expected

### The plan already draws the host/container path distinction

The brief devotes several pages to insisting that Windows host paths must never
reach Linux-container services, and that the installer must distinguish Windows
host path / Docker container path / UltraTorrent storage path. **The schema
already separates these**, on Linux, for the same underlying reason:

| Field | Space | Validated as |
|---|---|---|
| `Storage.MediaRoot` | **Host** | `filepath.IsAbs`, no `..` |
| `Library.Path` | **Container** | `strings.HasPrefix(…, "/downloads")` |
| `Intake.StagingPath` | **Container** | `strings.HasPrefix(…, "/downloads")` |

The container-side checks use `strings`, not `filepath`, so they stay POSIX on
any build — which is correct and, on the evidence of the comments, deliberate.

**Consequence:** Windows needs a host-path *mapper* and platform-aware host-path
*validation*. It does not need a schema redesign, a parallel plan type, or the
"formalize this distinction" work the brief describes. That work is done.

### The Detector is already dependency-injected

`host.Detector` injects `Runner`, `ReadFile`, `LookupPort`, `DialRegistry` and
`Statfs`. A Windows detector needs no new test strategy — the seam for "what does
Windows 11 24H2 with no WSL produce" is the same one that already answers "what
does Ubuntu 24.04 with Docker 19.03 produce".

### `PublishedPorts()` is the hook a firewall plan needs

It already enumerates every intended host binding with a human label, in one
place, as a slice rather than a map (deliberately — see its comment). A firewall
plan is a consumer of that list, not a new inventory to maintain.

---

## 3. Gaps

### W1. The module does not compile for Windows — and it is two lines

```
$ GOOS=windows GOARCH=amd64 go build ./...
internal/host/detect.go:371:16: undefined: unix.Statfs_t
internal/host/detect.go:372:17: undefined: unix.Statfs
```

`golang.org/x/sys/unix` is imported for free-disk measurement and nothing else.
Everything else in 3 124 lines is GOOS-neutral.

**Recommendation:** split `diskFree` into `disk_unix.go` / `disk_windows.go`
(`GetDiskFreeSpaceExW` via `golang.org/x/sys/windows`). Do this **first** — it is
an hour's work, it makes `GOOS=windows go build ./...` and `go test` part of the
gate from then on, and every later Windows phase depends on it. Until it lands,
nothing Windows can be compiled, let alone tested.

### W2. Plan validation silently changes meaning with the build target

`Validate()` uses `filepath.IsAbs`, `filepath.Clean` and `filepath.Separator` —
all of which are **GOOS-dependent**. Verified in Go's own source
(`internal/filepathlite/path_windows.go`): Windows `IsAbs` requires a volume
name, so `IsAbs("/opt/ultratorrent")` is **false** on a Windows build.

So today, the same `plan.json` that validates on Linux is rejected by the Windows
binary with *"must be an absolute path"*, and a Windows plan is rejected by the
Linux binary. A plan is explicitly meant to be *"readable, diffable, saved and
re-used"*, and `install --config plan.yaml` is an architected future — so this is
a contract bug waiting on the first cross-platform plan, not a theoretical one.

**Recommendation:** the plan must record the platform it targets (`host.os` is
already a field, currently only descriptive) and validate host paths against
**that**, not against `runtime.GOOS`. One `hostPath` validator with a platform
argument, exercised by table tests in both shapes from a Linux build. This is a
shared-core change and it should precede any Windows path work.

### W3. The storage mechanism does not survive the port

This is the most serious technical gap, and it is not in the brief.

The Linux audit's G4 records the field-proven pattern the installer is to adopt:
redefine the **named volume**, so backend, rtorrent and qbittorrent follow
together and cannot drift.

```yaml
volumes:
  downloads:
    driver: local
    driver_opts: { type: none, o: bind, device: /srv/ultratorrent/media }
```

`driver_opts` with `o: bind` is a **Linux `mount(2)` performed inside the Docker
VM**. `device: D:\Media` is not a path that exists there. Docker Desktop exposes
Windows drives to the VM under an implementation-defined mount root
(`/run/desktop/mnt/host/d/...`) that is not a documented, stable interface.

The Windows generator therefore cannot reuse the Linux one, and the obvious
alternative — per-service bind mounts (`- D:\Media:/downloads`) — reintroduces
exactly the three-way drift G4 chose the volume redefinition to avoid.

**Recommendation:** settle this by **experiment before Phase 5**, not by design
review. Test, on a real Docker Desktop/WSL2 host: (a) per-service binds, (b)
volume redefinition against the VM mount root, (c) a `downloads` volume declared
with a plain `driver_opts`-free bind in an override. Pick on evidence and record
why. Until it is settled, the Windows storage story is unknown, and the brief's
Phase 8 (config generation) cannot be specified.

### W4. `PUID`/`PGID` is largely meaningless on Docker Desktop

The plan applies `PUID`/`PGID` to the engines **and** the backend — correct on
Linux, and G4 records the deployed host that proves it. Windows bind mounts
through Docker Desktop do not carry NTFS ownership into the container in a way
those variables affect; files present as a fixed mapped identity.

**Recommendation:** the wizard must not ask for `PUID`/`PGID` on Windows, and the
review screen must not display them. Suppress rather than default: a number shown
on screen that has no effect is worse than an absent question. NTFS ACLs on the
install directory (the brief's real concern) are a separate axis and remain
required.

### W5. `0600` protects nothing on Windows, and one such write already ships

Go documents it plainly (`os.Chmod`): *"On Windows, only the 0o200 bit (owner
writable) of mode is used; it controls whether the file's read-only attribute is
set or cleared. The other bits are currently unused."* A `0600` file on Windows
is a file with the read-only attribute **cleared** and its parent's ACL
inherited — not a private one.

Two consequences, one future and one present:

- **Future.** `secrets.go` records the rule that generated values are written to
  exactly one place, *"`.env`, created 0600 before anything is written into it"*.
  No writer exists yet, so this is a design constraint rather than a live bug —
  but implemented naively it would put `POSTGRES_PASSWORD`, both JWT secrets and
  `ENCRYPTION_KEY` in a file whose code reads as protected and is not.
- **Present.** `plan --output` already writes with `0o600`
  (`cmd/ultratorrent-install/main.go:178`), reasoning in its comment that a plan
  "describes the deployment in detail". Compiled for Windows, that intent is
  silently inert today.

**Recommendation:** an ACL step is not a Windows nicety — it is what makes an
existing rule true on Windows. It belongs in the same change as the first Windows
file write, never later, and `doctor` must assert the resulting ACL rather than
trust the mode it passed.

### W6. Host detection acquires Linux facts, and says Linux things

`Detect()` reads `/etc/os-release` and `/proc/meminfo`, probes `sudo -n true`,
inspects the `docker` group and calls `os.Geteuid()`. `evaluate()` then emits
Linux remedies: *"re-run with sudo"*, *"sudo systemctl start docker"*,
*"supported: Ubuntu and Debian"*.

The split is clean, though: the `Finding`/`Report`/`Level` model, the
Docker-version and Compose-legacy rules, port checks, architecture and registry
reachability are all platform-neutral and worth keeping verbatim.

**Recommendation:** extract a `PlatformDetector` interface (OS identity,
privileges, memory, Docker install capability) with Linux and Windows
implementations; keep `evaluate()` shared but move its remedy strings behind the
platform so "re-run elevated" and "re-run with sudo" are the same rule with two
renderings. Resist a second `evaluate()`.

### W7. There is no executor to sit beside

Phases 4–17 of the brief describe Windows counterparts to a Linux executor,
config generator, status, doctor, reconfigure and upgrade — **none of which
exist**. Building them Windows-first would make Windows the reference
implementation of shared behaviour, which is the outcome the brief's own final
rules forbid ("Do not duplicate shared business logic", "Do not regress the Linux
installer").

**Recommendation, and the main sequencing point of this audit:** Windows must not
start at the bootstrap or the executor. It should start at the *seams* (W1, W2,
W6), which are cheap, are useful to Linux, and are what make a Windows executor
possible later. The executor interface should be designed once, when the Linux
executor is built, with Windows in the room — not retrofitted afterwards, and not
raced.

### W8. `SupportedDistros` is the wrong shape for Windows

Support is a map of os-release IDs (`ubuntu`, `debian`) with `ID_LIKE`
derivative handling. Windows support is an edition-and-build question (11 Pro /
Enterprise, Server 2022/2025), and the brief explicitly forbids claiming Server
support without real end-to-end tests. A `windows` key in the same map would
encode a claim nobody has tested.

**Recommendation:** platform-specific support predicates behind the same
`OSInfo.Supported` boolean. Windows Server must default to *unsupported until
tested*, and the reason must be visible in the system check rather than silent.

### W9. Localization is scaffolded and empty — and there is now a working pattern

`clients/installer/internal/i18n/` exists and contains nothing, exactly as
`clients/console/internal/i18n/` did until this week. The console's catalogs are
now built and proven: embedded JSON, format strings rather than sentences, and
tests asserting key-set parity and `%`-verb parity between locales.

**Recommendation:** adopt that package's shape wholesale, and do it **before**
Windows strings exist rather than at the brief's Phase 16. Every Windows finding,
remedy and wizard prompt written in the meantime is a string that will otherwise
have to be found and moved later — and the console's experience is that the
strings which get missed are the ones in error paths nobody re-reads.

### W10. Windows path hazards have no counterpart in the current validation

`withinPath` compares cleaned paths with `strings.HasPrefix` — **case-sensitive**.
NTFS is case-insensitive, so `d:\media` inside `D:\ProgramData\UltraTorrent`
would defeat the "keep media out of the install directory" guard. There is also
no handling of junctions, reparse points, alternate data streams, reserved device
names (`CON`, `NUL`, `LPT1`) or UNC semantics — all of which the brief names.

**Recommendation:** these belong in the platform-aware host-path validator from
W2, not scattered. Case-insensitive comparison on Windows is a one-line change
that should not wait for the rest.

### W11. Docker installation is a bigger promise on Windows than on Linux

The Linux audit's G2 records that Docker installation is out of scope everywhere
today. The Windows brief makes installing Docker Desktop first-class, *plus*
enabling WSL2/virtualization features, *plus* surviving a reboot and resuming.

Reboot/resume has no counterpart in the current model: there is no
`installer-state.json` implementation at all — the file is named in comments and
docs, and nothing writes it.

**Recommendation:** treat installer **state** as shared-core work (Linux wants
resumability too, for a failed pull or a half-applied stack) and reboot detection
as the Windows specialization of it. Designing state as a Windows feature would
be the second place the product forks.

### W12. Missing shared commands are not Windows gaps

`status`, `doctor`, `reconfigure` and `upgrade` are named in the brief's Windows
requirements and do not exist on either platform. Their Windows-specific content
(WSL state, Docker backend, ACLs, firewall rules, pending reboot) is real, but it
is *additional findings inside a shared command*, not a Windows command set.

---

## 4. What is genuinely Windows-specific

After the audit, the Windows-only surface is smaller than the brief's component
list implies. Of the nine proposed components:

| Brief's component | Verdict |
|---|---|
| `WindowsHostDetector` | **Yes** — platform implementation behind the W6 seam |
| `WindowsPrivilegeService` | **Yes** — elevation detection/relaunch has no Linux analogue |
| `WindowsDockerDetector` | **Partly** — Docker/Compose version rules are shared; backend/WSL/Linux-container-mode detection is new |
| `WindowsDockerInstaller` | **Yes** — and it is the largest single piece of new work |
| `WindowsPathMapper` | **Yes** — but consuming the existing host/container split, not defining one |
| `WindowsFirewallService` | **Yes** — consuming `PublishedPorts()` |
| `WindowsCredentialService` | **Yes** — DPAPI/Credential Manager, plus the W5 ACL work |
| `WindowsExecutor` | **Blocked** on the executor interface existing (W7) |
| `WindowsDiagnosticsService` | **No** — this is `doctor` with extra findings (W12) |

**One thing the brief treats as Windows-only that should be shared:** "Who should
be able to access UltraTorrent?" The plan today publishes ports with no
bind-address concept at all — a Linux install binds `0.0.0.0` and says nothing
about it. Exposure scope is the same question on both platforms; it should live
in the plan and be *enforced* by a firewall plan on Windows and a bind address on
Linux. Modelling it as a Windows firewall struct would leave Linux with the
weaker behaviour permanently.

---

## 5. Recommended delivery order

Adjusted from the brief, with the reasons above.

**Now, and useful regardless of Windows:**

1. **W1** — platform-split `diskFree`; add `GOOS=windows` build + `go test` to the gate.
2. **W2** — platform-aware host-path validation; plan records its target platform.
3. **W10** — case-insensitive containment and Windows path hazards, in that validator.
4. **W9** — adopt the console's i18n package shape before more strings exist.
5. **W6** — extract the platform-detector seam; keep one `evaluate()`.

**Next, by experiment rather than design:**

6. **W3** — settle Windows storage on a real Docker Desktop host. Record the evidence.
7. Confirm W4 and W5 empirically on the same host while it is available.

**Then, and not before the Linux executor exists (W7):**

8. Installer state and resumability as shared core; reboot detection as its Windows case (W11).
9. `WindowsDockerInstaller`, the PowerShell bootstrap, firewall and credential services.
10. Windows executor beside the Linux one, against an interface designed with both in view.

**Not yet:** Windows Server support claims, WinGet/MSI packaging, unattended mode.
Each depends on tests that cannot run until the above exists, and the brief is
explicit that support must not be claimed before those tests pass.

---

## 6. Open questions for the maintainer

1. **Is Windows a first-class target or a second one?** If the Linux executor is
   weeks away, steps 1–5 are still worth doing now; steps 8–10 should wait. If
   Windows is meant to ship *first*, the executor interface must be designed
   deliberately rather than emerging from whichever platform is written first —
   and that is a decision, not a detail.
2. **Docker Desktop licensing.** Its terms are not permissive for all
   organizations. The brief says not to offer it where licensing makes it
   inappropriate — but the installer cannot detect an organization's headcount.
   The honest options are to state the requirement and let the administrator
   decide, or to refuse Windows Server entirely in v1.
3. **Windows Server without an interactive session.** The brief already suspects
   this: Docker Desktop's architecture expects a logged-in user. If that holds on
   testing, Server support in v1 is a documentation statement, not a feature.
