// Command ultratorrent-install deploys and maintains an UltraTorrent stack.
//
// This build can inspect a host, plan an installation, and generate the
// configuration files that installation needs. It cannot yet deploy: nothing
// here runs Docker. That boundary is enforced by construction rather than by
// care — no package linked into this binary can start a container.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/ultratorrent/installer/internal/config"
	"github.com/ultratorrent/installer/internal/host"
	"github.com/ultratorrent/installer/internal/plan"
	"github.com/ultratorrent/installer/internal/storage"
)

// Set by the linker: -ldflags "-X main.version=…".
//
// The installer versions independently of UltraTorrent. They move for different
// reasons — a wizard fix is not a platform release — and coupling them would
// mean reissuing one to ship the other.
var (
	version = "0.1.0-dev"
	commit  = "unknown"
)

const usage = `UltraTorrent Installer — deploy and maintain an UltraTorrent stack.

Usage:
  ultratorrent-install plan [flags]        Build a plan and print it; changes nothing
  ultratorrent-install generate [flags]    Write the configuration files; deploys nothing
  ultratorrent-install install [flags]     Install (use --dry-run to preview)
  ultratorrent-install version             Installer, plan schema and build

Flags:
  --dry-run           Produce and show the plan, then stop without changing anything
  --output FILE       Write the plan as JSON (never contains secrets)
  --json              Print the plan as JSON instead of the review screen
  --install-dir PATH  Installation directory (default %s)
  --port N            Host port for the web UI (default %d)
  --engine NAME       qbittorrent | rtorrent | external | none (default qbittorrent)
  --media-root PATH   Host path for media; omit to use a Docker volume
  --puid N            Own downloaded files as this user id (see below)
  --pgid N            Own downloaded files as this group id
  --prowlarr          Deploy the Prowlarr indexer manager
  --flaresolverr      Deploy FlareSolverr (requires --prowlarr)
  --skip-checks       Skip the system check (planning only; never for install)

--puid/--pgid should be the owner of your media directory. They apply to the
bundled engine AND the backend, which writes into the same tree — setting only
one side leaves files the other cannot manage.

Not yet implemented in this build: the interactive wizard and deployment. This
build can inspect, plan, and write configuration.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ultratorrent-install: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	command := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}

	fs := flag.NewFlagSet("ultratorrent-install", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var (
		dryRun       = fs.Bool("dry-run", false, "produce the plan and stop")
		output       = fs.String("output", "", "write the plan as JSON to this file")
		asJSON       = fs.Bool("json", false, "print the plan as JSON")
		installDir   = fs.String("install-dir", plan.DefaultInstallDirectory, "installation directory")
		port         = fs.Int("port", plan.DefaultFrontendPort, "host port for the web UI")
		engine       = fs.String("engine", string(plan.EngineQbittorrent), "torrent engine")
		mediaRoot    = fs.String("media-root", "", "host path for media")
		withProwlarr = fs.Bool("prowlarr", false, "deploy Prowlarr")
		withFlare    = fs.Bool("flaresolverr", false, "deploy FlareSolverr")
		puid         = fs.Int("puid", 0, "own downloaded files as this user id")
		pgid         = fs.Int("pgid", 0, "own downloaded files as this group id")
		skipChecks   = fs.Bool("skip-checks", false, "skip the system check")
	)
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, usage, plan.DefaultInstallDirectory, plan.DefaultFrontendPort)
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	switch command {
	case "version":
		fmt.Printf("ultratorrent-install %s (%s), plan schema v%d\n",
			version, commit, plan.SchemaVersion)
		return nil

	case "plan":
		p, err := build(*installDir, *port, *engine, *mediaRoot, *withProwlarr, *withFlare, *puid, *pgid)
		if err != nil {
			return err
		}
		if !*skipChecks && !*asJSON {
			fmt.Print(inspect(p).String())
		}
		return emit(p, *asJSON, *output)

	case "generate":
		p, err := build(*installDir, *port, *engine, *mediaRoot, *withProwlarr, *withFlare, *puid, *pgid)
		if err != nil {
			return err
		}
		if !*skipChecks {
			report := inspect(p)
			fmt.Print(report.String())
			if report.Blocked() {
				return fmt.Errorf("this host cannot run UltraTorrent yet — " +
					"resolve the failures above and re-run. Nothing has been changed")
			}
		}
		return generate(p, *dryRun)

	case "install":
		p, err := build(*installDir, *port, *engine, *mediaRoot, *withProwlarr, *withFlare, *puid, *pgid)
		if err != nil {
			return err
		}
		// The system check runs BEFORE the plan is shown, and its failures are
		// reported before anything else: a plan is not worth reviewing on a host
		// that cannot run it.
		report := inspect(p)
		fmt.Print(report.String())
		if report.Blocked() {
			return fmt.Errorf("this host cannot run UltraTorrent yet — " +
				"resolve the failures above and re-run. Nothing has been changed")
		}
		if err := emit(p, *asJSON, *output); err != nil {
			return err
		}
		if *dryRun {
			fmt.Println("\nDry run — nothing has been changed.")
			return nil
		}
		// Deliberate: rather than a stub that pretends, say plainly what this
		// build can and cannot do. An installer that half-installs is worse than
		// one that refuses — and it refuses BEFORE writing anything, so a failed
		// `install` never leaves configuration behind for a stack that does not
		// exist. `generate` is the supported way to get the files today.
		return fmt.Errorf("this build can plan and generate configuration, but not " +
			"deploy — run `generate` to write the configuration files, then bring the " +
			"stack up with docker compose")

	case "", "help":
		fs.Usage()
		return nil

	default:
		fs.Usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

// build turns flags into a validated plan.
//
// Flags stand in for the wizard for now; the wizard will populate the same
// struct, so everything downstream is already exercised.
func build(installDir string, port int, engine, mediaRoot string, prowlarr, flare bool, puid, pgid int) (*plan.Plan, error) {
	p := plan.Recommended(version)
	p.InstallDirectory = installDir
	p.Networking.FrontendPort = port
	p.Torrent.Engine = plan.Engine(engine)

	if mediaRoot != "" {
		p.Storage.Mode = plan.StorageBind
		p.Storage.MediaRoot = mediaRoot
	}
	// One given without the other is almost always a typo rather than an
	// intent — mirroring it is what the operator meant, and a half-set pair
	// produces files the other side cannot manage.
	if puid > 0 && pgid == 0 {
		pgid = puid
	}
	if pgid > 0 && puid == 0 {
		puid = pgid
	}
	p.Torrent.PUID, p.Torrent.PGID = puid, pgid

	p.Companions.Prowlarr = prowlarr
	p.Companions.FlareSolverr = flare
	p.Finalize()

	problems := p.Validate()
	if plan.Fatal(problems) {
		var b strings.Builder
		b.WriteString("this plan cannot be installed:\n")
		for _, problem := range plan.Errors(problems) {
			b.WriteString("  • " + problem.String() + "\n")
		}
		return nil, fmt.Errorf("%s", b.String())
	}
	return p, nil
}

func emit(p *plan.Plan, asJSON bool, output string) error {
	if output != "" {
		// 0600: a plan holds no secrets by construction, but it does describe
		// the topology of someone's server, and the cost of being careful is
		// nothing.
		f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		if err := p.WriteJSON(f); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Plan written to %s\n", output)
	}
	if asJSON {
		return p.WriteJSON(os.Stdout)
	}
	fmt.Print(review(p))
	return nil
}

// review renders the plan the way the wizard will, before any confirmation.
//
// The whole point of the plan model: this is generated from the same object the
// executor would apply, so it cannot describe something else.
func review(p *plan.Plan) string {
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)

	fmt.Fprintf(w, "\nInstallation Plan\n\n")
	fmt.Fprintf(w, "UltraTorrent\n")
	fmt.Fprintf(w, "  Install path\t%s\n", p.InstallDirectory)
	fmt.Fprintf(w, "  Web port\t%d\n", p.Networking.FrontendPort)
	if p.Networking.PublicURL != "" {
		fmt.Fprintf(w, "  Public URL\t%s\n", p.Networking.PublicURL)
	}

	fmt.Fprintf(w, "\nTorrent engine\n  %s\n", engineLabel(p.Torrent.Engine))

	fmt.Fprintf(w, "\nCore services\n")
	fmt.Fprintf(w, "  PostgreSQL\tinternal only\n")
	fmt.Fprintf(w, "  Redis\tinternal only\n")

	fmt.Fprintf(w, "\nStorage\n")
	if p.Storage.Mode == plan.StorageBind {
		fmt.Fprintf(w, "  Media root\t%s (host path)\n", p.Storage.MediaRoot)
	} else {
		fmt.Fprintf(w, "  Media\tDocker volume 'downloads'\n")
	}
	for _, lib := range p.Storage.Libraries {
		fmt.Fprintf(w, "  %s\t%s\n", lib.Name, lib.Path)
	}

	fmt.Fprintf(w, "\nOptional services\n")
	fmt.Fprintf(w, "  Prowlarr\t%s\n", yesNo(p.Companions.Prowlarr))
	fmt.Fprintf(w, "  FlareSolverr\t%s\n", yesNo(p.Companions.FlareSolverr))
	fmt.Fprintf(w, "  Bundled proxy\t%s\n", yesNo(p.Networking.UseBundledProxy))

	fmt.Fprintf(w, "\nSecurity\n")
	fmt.Fprintf(w, "  Database password\tgenerated\n")
	fmt.Fprintf(w, "  JWT secrets\tgenerated\n")
	fmt.Fprintf(w, "  Encryption key\tgenerated\n")
	fmt.Fprintf(w, "  Admin password\t%s\n",
		map[bool]string{true: "generated", false: "supplied"}[p.Admin.GeneratePassword])

	if len(p.Profiles) > 0 {
		fmt.Fprintf(w, "\nCompose profiles\n  %s\n", strings.Join(p.Profiles, ", "))
	}

	ports := p.PublishedPorts()
	sort.Slice(ports, func(i, j int) bool { return ports[i].Port < ports[j].Port })
	fmt.Fprintf(w, "\nPorts published on this host\n")
	for _, binding := range ports {
		fmt.Fprintf(w, "  %d\t%s\n", binding.Port, binding.Label)
	}

	if len(p.Warnings) > 0 {
		fmt.Fprintf(w, "\nWarnings\n")
		for _, warning := range p.Warnings {
			fmt.Fprintf(w, "  ! %s\n", warning)
		}
	}
	w.Flush()
	return b.String()
}

func engineLabel(e plan.Engine) string {
	switch e {
	case plan.EngineQbittorrent:
		return "qBittorrent (bundled)"
	case plan.EngineRtorrent:
		return "rTorrent (bundled)"
	case plan.EngineExternal:
		return "external engine"
	case plan.EngineNone:
		return "none — configure later"
	}
	return string(e)
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// inspect runs the read-only system check for a plan.
//
// The plan supplies the ports, so the check tests what THIS installation will
// bind rather than a hard-coded list that drifts from what is deployed.
func inspect(p *plan.Plan) *host.Report {
	wanted := make([]host.PortStatus, 0, 4)
	for _, binding := range p.PublishedPorts() {
		wanted = append(wanted, host.PortStatus{Port: binding.Port, Label: binding.Label})
	}
	return host.NewDetector().Detect(context.Background(), p.InstallDirectory, wanted)
}

// generate writes the configuration an installation needs, and nothing else.
//
// It deploys nothing. That separation is useful in its own right — an operator
// who prefers to run `docker compose` themselves gets correct, complete
// configuration without handing the installer control of their stack.
func generate(p *plan.Plan, dryRun bool) error {
	writer := &config.Writer{Dir: p.InstallDirectory, DryRun: dryRun}

	secrets, reused, err := resolveSecrets(p.InstallDirectory)
	if err != nil {
		return err
	}
	if problems := secrets.Validate(); len(problems) > 0 {
		// Reached only for secrets read back from an existing .env — generated
		// ones cannot fail this. Refusing beats deploying a stack the backend
		// will reject at boot with a message about a variable the operator never
		// set by hand.
		return fmt.Errorf("the secrets in %s/%s are not usable: %s\n"+
			"UltraTorrent's backend refuses to start with these. Fix them in place, "+
			"or move the file aside to have a fresh set generated",
			p.InstallDirectory, config.EnvFileName, strings.Join(problems, "; "))
	}

	fmt.Println()
	if reused {
		// Worth saying out loud. The alternative — silently minting new secrets —
		// would break a live deployment in a way that looks like data loss.
		fmt.Printf("Existing secrets found in %s and kept unchanged.\n", config.EnvFileName)
	} else {
		fmt.Println("New secrets generated.")
	}

	// Storage first: a bind-backed volume whose device does not exist does not
	// fail at `compose config` and is not created on demand — the container fails
	// to START, with an error naming an internal Docker path and no hint that a
	// host directory is missing. Preparing it before anything else means that
	// error cannot happen.
	if err := prepareStorage(p, dryRun); err != nil {
		return err
	}

	actions, err := writer.EnsureDir()
	if err != nil {
		return err
	}
	all := []config.Action{actions}

	files := config.Render(p, secrets)
	written := make([]string, 0, len(files))
	for _, f := range files {
		acts, err := writer.Write(f)
		if err != nil {
			return err
		}
		all = append(all, acts...)
		written = append(written, f.Name)
	}
	// A plan that no longer needs an override must not leave the previous one
	// behind: Compose would keep merging settings the operator has removed.
	if !containsName(files, config.OverrideFileName) {
		acts, err := writer.Remove(config.OverrideFileName)
		if err != nil {
			return err
		}
		all = append(all, acts...)
	}
	if acts, err := writeState(writer, p, written); err != nil {
		return err
	} else {
		all = append(all, acts...)
	}

	fmt.Println()
	for _, a := range all {
		fmt.Println("  " + a.String())
	}

	if dryRun {
		fmt.Println("\nDry run — nothing has been changed.")
		return nil
	}
	printNextSteps(p, reused)
	return nil
}

// prepareStorage inspects and creates the host directories the stack needs.
//
// Inspection runs first and in full: an operator who has three problems should
// see three, not discover them one failed run at a time.
func prepareStorage(p *plan.Plan, dryRun bool) error {
	dirs := storage.Plan(p)
	if len(dirs) == 0 {
		return nil
	}
	ops := storage.DefaultOps()

	fmt.Println("\nStorage")
	fmt.Print(storage.Summary(dirs))

	findings := storage.Inspect(dirs, p.InstallDirectory, ops)
	for _, f := range findings {
		if f.Level == host.LevelOK {
			continue
		}
		fmt.Printf("  %-11s %s: %s\n", storageLevel(f.Level), f.Value, f.Detail)
		if f.Remedy != "" {
			fmt.Printf("           %s\n", f.Remedy)
		}
	}
	if storage.Blocked(findings) {
		return fmt.Errorf("the storage layout cannot be prepared — " +
			"resolve the failures above and re-run. Nothing has been changed")
	}

	actions, err := storage.Prepare(dirs, ops, dryRun)
	for _, a := range actions {
		fmt.Println("  " + a.String())
	}
	if err != nil {
		return err
	}
	return nil
}

// storageLevel words a finding for a directory.
//
// The shared LevelAction renders as "WILL INSTALL", which is right for a missing
// Docker and wrong for a missing directory — the operator should read what will
// actually happen to the thing named on the line.
func storageLevel(l host.Level) string {
	if l == host.LevelAction {
		return "WILL CREATE"
	}
	return string(l)
}

// resolveSecrets keeps an existing installation's secrets, or mints a fresh set.
//
// This is the whole of re-run safety. Regenerating against a live deployment is
// catastrophic and quiet: the database password stops matching the volume that
// already holds the data, every session is invalidated, and a changed
// ENCRYPTION_KEY makes every stored two-factor secret undecryptable. So an
// existing .env is read and its secrets reused — never replaced, and never
// without saying so.
func resolveSecrets(dir string) (*plan.Secrets, bool, error) {
	existing, err := os.ReadFile(filepath.Join(dir, config.EnvFileName))
	switch {
	case err == nil:
		if s := config.ExistingSecrets(string(existing)); s != nil {
			return s, true, nil
		}
		// The file exists but holds no usable secrets — it was never a working
		// installation, so there is nothing to preserve.
	case !os.IsNotExist(err):
		return nil, false, fmt.Errorf("reading the existing %s: %w", config.EnvFileName, err)
	}

	s, err := plan.GenerateSecrets()
	if err != nil {
		return nil, false, fmt.Errorf("generating secrets: %w", err)
	}
	return s, false, nil
}

// writeState records the non-secret shape of the deployment.
//
// Any previous state is read first so facts a fresh one cannot know are carried
// forward — when the installation actually happened, above all.
func writeState(w *config.Writer, p *plan.Plan, generated []string) ([]config.Action, error) {
	state := config.StateFrom(p, generated)
	state.CarryForward(previousState(w.Dir))

	var buf strings.Builder
	if err := config.WriteState(&buf, state); err != nil {
		return nil, err
	}
	return w.Write(config.File{
		Name:    config.StateFileName,
		Mode:    config.ModePublic,
		Content: buf.String(),
	})
}

// previousState reads the state already in the installation directory.
//
// A missing or unreadable state file is not an error worth stopping for: it is a
// record of a deployment, not a prerequisite for one, and refusing to proceed
// because a metadata file is corrupt would be a worse outcome than losing the
// metadata. Warnings from a newer schema are surfaced rather than swallowed.
func previousState(dir string) *config.State {
	f, err := os.Open(filepath.Join(dir, config.StateFileName))
	if err != nil {
		return nil
	}
	defer f.Close()

	state, warnings, err := config.ReadState(f)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not read the existing %s (%v); "+
			"it will be rewritten\n", config.StateFileName, err)
		return nil
	}
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
	return state
}

func containsName(files []config.File, name string) bool {
	for _, f := range files {
		if f.Name == name {
			return true
		}
	}
	return false
}

// printNextSteps says what to do with the files that were just written.
//
// The initial administrator password is deliberately NOT printed. It is in
// `.env` at 0600; echoing it would put it in scrollback, in a terminal
// recording, and in whatever the operator pastes into an issue.
func printNextSteps(p *plan.Plan, reused bool) {
	env := filepath.Join(p.InstallDirectory, config.EnvFileName)
	fmt.Printf(`
Configuration written. Nothing has been deployed.

To bring the stack up, from the repository root:

    docker compose --env-file %s up -d

Then, once the backend is healthy, seed the first administrator:

    docker compose exec backend npx prisma db seed

The web UI will be at %s
`, env, publicAddress(p))

	if p.Torrent.Engine == plan.EngineQbittorrent {
		fmt.Printf(`
The bundled qBittorrent was seeded with its own password, so it will not print a
temporary one to its log. Both the Web UI sign-in and the credentials to give
UltraTorrent under Settings -> Integrations are in
%s
`, filepath.Join(p.InstallDirectory, config.EngineCredentialsFileName))
	}

	if !reused {
		fmt.Printf(`
The initial administrator is %q. Its password was generated into %s
and is not printed here — read it from that file, and change it after the first
sign-in.
`, p.Admin.Username, env)
	}
}

// publicAddress is what to type into a browser.
func publicAddress(p *plan.Plan) string {
	if p.Networking.PublicURL != "" {
		return p.Networking.PublicURL
	}
	return fmt.Sprintf("http://localhost:%d", p.Networking.FrontendPort)
}
