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
	"time"

	"github.com/ultratorrent/installer/internal/companion"
	"github.com/ultratorrent/installer/internal/config"
	"github.com/ultratorrent/installer/internal/console"
	"github.com/ultratorrent/installer/internal/deploy"
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
  --target OS         Target operating system: linux | windows (default: this host)
  --install-dir PATH  Installation directory (default %s)
  --port N            Host port for the web UI (default %d)
  --engine NAME       qbittorrent | rtorrent | external | none (default qbittorrent)
  --external-url URL  Where your existing engine is, for --engine external
  --rebuild           Build the images even when they already match this checkout
  --media-root PATH   Host path for media; omit to use a Docker volume
  --puid N            Own downloaded files as this user id (see below)
  --pgid N            Own downloaded files as this group id
  --public-url URL    The address users will type; becomes CORS_ORIGIN
  --bundled-proxy     Deploy the bundled Caddy reverse proxy (takes ports 80/443)
  --publish-prowlarr  Publish Prowlarr's Web UI (starts with NO authentication)
  --no-publish-webui  Keep the engine's Web UI off the host network
  --prowlarr          Deploy the Prowlarr indexer manager
  --flaresolverr      Deploy FlareSolverr (requires --prowlarr)
  --repo PATH         Checkout that holds docker-compose.yml (default: this directory)
  --skip-checks       Skip the system check (planning only; never for install)

--puid/--pgid should be the owner of your media directory. They apply to the
bundled engine AND the backend, which writes into the same tree — setting only
one side leaves files the other cannot manage.

install deploys the stack: it writes the configuration, then builds and starts
the containers and waits for them to become healthy. Not yet implemented in
this build: the interactive wizard.
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
		target       = fs.String("target", "", "target operating system: linux | windows")
		installDir   = fs.String("install-dir", plan.DefaultInstallDirectory, "installation directory")
		repoDir      = fs.String("repo", ".", "directory holding docker-compose.yml")
		port         = fs.Int("port", plan.DefaultFrontendPort, "host port for the web UI")
		engine       = fs.String("engine", string(plan.EngineQbittorrent), "torrent engine")
		mediaRoot    = fs.String("media-root", "", "host path for media")
		publicURL    = fs.String("public-url", "", "the address users will type")
		externalURL  = fs.String("external-url", "", "where an already-running engine lives")
		rebuild      = fs.Bool("rebuild", false, "build the images even if they are up to date")
		bundledProxy = fs.Bool("bundled-proxy", false, "deploy the bundled reverse proxy")
		pubProwlarr  = fs.Bool("publish-prowlarr", false, "publish Prowlarr's Web UI")
		noWebUI      = fs.Bool("no-publish-webui", false, "keep the engine's Web UI internal")
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
		// Say whether a console is aboard: the first question in any support
		// conversation about utconsole is which binary the user actually has.
		if console.Available() {
			fmt.Printf("console %s included (%.1f MB)\n",
				console.Name, float64(console.Size())/(1<<20))
		} else {
			fmt.Println("no console included in this build")
		}
		return nil

	case "plan":
		p, err := build(buildOpts{
			target: *target, installDir: *installDir, repoDir: *repoDir, port: *port,
			engine: *engine, mediaRoot: *mediaRoot, prowlarr: *withProwlarr, flare: *withFlare,
			puid: *puid, pgid: *pgid, publicURL: *publicURL, externalURL: *externalURL, forceRebuild: *rebuild, bundledProxy: *bundledProxy,
			pubProwlarr: *pubProwlarr, publishWebUI: !*noWebUI,
		})
		if err != nil {
			return err
		}
		if !*skipChecks && !*asJSON {
			fmt.Print(inspect(p).String())
		}
		return emit(p, *asJSON, *output)

	case "generate":
		p, err := build(buildOpts{
			target: *target, installDir: *installDir, repoDir: *repoDir, port: *port,
			engine: *engine, mediaRoot: *mediaRoot, prowlarr: *withProwlarr, flare: *withFlare,
			puid: *puid, pgid: *pgid, publicURL: *publicURL, externalURL: *externalURL, forceRebuild: *rebuild, bundledProxy: *bundledProxy,
			pubProwlarr: *pubProwlarr, publishWebUI: !*noWebUI,
		})
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
		_, err = generate(p, *dryRun, false)
		return err

	case "install":
		p, err := build(buildOpts{
			target: *target, installDir: *installDir, repoDir: *repoDir, port: *port,
			engine: *engine, mediaRoot: *mediaRoot, prowlarr: *withProwlarr, flare: *withFlare,
			puid: *puid, pgid: *pgid, publicURL: *publicURL, externalURL: *externalURL, forceRebuild: *rebuild, bundledProxy: *bundledProxy,
			pubProwlarr: *pubProwlarr, publishWebUI: !*noWebUI,
		})
		if err != nil {
			return err
		}
		// The system check runs BEFORE the plan is shown, and its failures are
		// reported before anything else: a plan is not worth reviewing on a host
		// that cannot run it.
		report := inspect(p)
		fmt.Print(report.String())

		// The report says "Docker: not installed  WILL INSTALL" when it can be
		// installed here. Doing it is what makes that line true — until now
		// nothing implemented it, so the promise was followed by every docker
		// command failing for want of docker.
		if report.NeedsDockerInstalled() {
			if *dryRun {
				fmt.Println("\nDocker would be installed before deploying.")
			} else if err := installDocker(p); err != nil {
				return err
			} else {
				// Re-check rather than assume: the report is what the rest of
				// this command reasons about, and it currently says Docker is
				// missing. A stale report would fail the port and registry
				// checks that the new daemon has just made answerable.
				report = inspect(p)
				fmt.Print(report.String())
			}
		}

		if report.Blocked() {
			return fmt.Errorf("this host cannot run UltraTorrent yet — " +
				"resolve the failures above and re-run. Nothing has been changed")
		}
		if err := emit(p, *asJSON, *output); err != nil {
			return err
		}
		if *dryRun {
			// Run generate in dry-run rather than stopping here. The storage
			// inspection lives inside it, and it is the half of the preview an
			// operator most needs: ownership that will not let the engine write,
			// a media root that is really the unmounted mountpoint, a path whose
			// parent does not exist. Returning early showed the system check and
			// the plan and silently skipped all of it — so `install --dry-run`
			// promised a preview and gave a partial one.
			_, err := generate(p, true, true)
			return err
		}
		g, err := generate(p, false, true)
		if err != nil {
			return err
		}
		return deployStack(p, g)

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
// buildOpts are the wizard's answers, standing in for the wizard for now.
type buildOpts struct {
	target       string
	installDir   string
	repoDir      string
	port         int
	engine       string
	mediaRoot    string
	prowlarr     bool
	flare        bool
	puid, pgid   int
	publicURL    string
	externalURL  string
	forceRebuild bool
	bundledProxy bool
	pubProwlarr  bool
	publishWebUI bool
}

func build(o buildOpts) (*plan.Plan, error) {
	installDir, port, engine, mediaRoot := o.installDir, o.port, o.engine, o.mediaRoot
	prowlarr, flare, puid, pgid := o.prowlarr, o.flare, o.puid, o.pgid

	/*
	 * The target decides every default below it, so it is resolved first.
	 * `--target windows` from a Linux box is a supported thing to do: a plan is
	 * a document, and authoring one for the machine you are about to walk over
	 * to is exactly what saving and reviewing a plan is for.
	 */
	target := plan.DefaultTargetOS()
	if o.target != "" {
		target = plan.TargetOS(strings.ToLower(o.target))
		if !target.Valid() {
			return nil, fmt.Errorf("unknown target %q — expected linux or windows", o.target)
		}
	}

	p := plan.RecommendedFor(version, target)
	// An install directory left at the flag's own default belongs to the
	// platform the binary was built for, not to the target that was asked for.
	if installDir == "" || installDir == plan.DefaultInstallDirectory {
		installDir = plan.DefaultInstallDirectoryFor(target)
	}
	p.InstallDirectory = installDir
	p.RepoDirectory = o.repoDir
	p.Networking.FrontendPort = port
	p.Networking.PublicURL = o.publicURL
	p.Networking.UseBundledProxy = o.bundledProxy
	p.Companions.PublishProwlarrUI = o.pubProwlarr
	p.Torrent.PublishWebUI = o.publishWebUI
	p.Torrent.Engine = plan.Engine(engine)
	p.Torrent.ExternalURL = o.externalURL
	p.ForceRebuild = o.forceRebuild

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
	// Shown on every plan, not only a cross-platform one: the host paths below
	// only mean anything against a target, and a review screen that omitted it
	// would be ambiguous exactly when it mattered.
	fmt.Fprintf(w, "  Target\t%s\n", p.TargetOS)
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
// needsResetTag reports whether the generated override will use `!reset`.
//
// Only a plan that keeps a normally-published service off the host network does,
// which keeps the Compose version requirement proportional to what this
// installation actually generates.
func needsResetTag(p *plan.Plan) bool {
	if p.Companions.Prowlarr && !p.Companions.PublishProwlarrUI {
		return true
	}
	return p.Torrent.Engine == plan.EngineQbittorrent && !p.Torrent.PublishWebUI
}

// installDocker carries out the installation the system check promised.
//
// Given its own runner with a generous timeout: the detection runner allows ten
// seconds, which is right for asking `docker version` and nowhere near enough
// for apt fetching several hundred megabytes.
func installDocker(p *plan.Plan) error {
	fmt.Println("\nInstalling Docker")
	run := host.ExecRunner{Timeout: 20 * time.Minute}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	if err := host.InstallDocker(ctx, run, func(step string) {
		fmt.Println("  " + step)
	}); err != nil {
		return err
	}
	fmt.Println("  Docker installed")
	return nil
}

func inspect(p *plan.Plan) *host.Report {
	wanted := make([]host.PortStatus, 0, 4)
	for _, binding := range p.PublishedPorts() {
		wanted = append(wanted, host.PortStatus{Port: binding.Port, Label: binding.Label})
	}
	detector := host.NewDetector()
	// Named so the port check can tell this installation's own running stack
	// from an unrelated service holding the same port.
	detector.ProjectName = p.ProjectName
	report := detector.Detect(context.Background(), p.InstallDirectory, wanted)
	if p.Companions.Prowlarr && p.Companions.PublishProwlarrUI {
		report.WarnPublishedProwlarr(p.Companions.ProwlarrPort)
	}
	if needsResetTag(p) {
		report.RequireResetTag()
	}
	report.Add(composeFileFinding(p.RepoDirectory))
	return report
}

// composeFileFinding reports whether the repo directory actually holds the
// Compose file the deployment will be built from.
//
// Checked here rather than in Plan.Validate, which is deliberately pure — "is
// this true of the plan" and "is this true of this machine" are separate
// questions, and mixing them would make the plan model untestable without a
// host. Checked at all because the alternative is discovering it half way
// through a deploy, after configuration has been written.
func composeFileFinding(repoDir string) host.Finding {
	const label = "Compose file"
	if repoDir == "" {
		return host.Finding{
			Label: label, Value: "no repository directory", Level: host.LevelFail,
			Detail: "Pass --repo with the directory holding " + deploy.BaseFile +
				". It is not guessed: deriving a directory is how an installation " +
				"attaches itself to a stack it did not create.",
		}
	}
	full := filepath.Join(repoDir, deploy.BaseFile)
	if _, err := os.Stat(full); err != nil {
		return host.Finding{
			Label: label, Value: "not found in " + repoDir, Level: host.LevelFail,
			Detail: "Expected " + full + ". Pass --repo with the checkout that holds it.",
		}
	}
	return host.Finding{Label: label, Value: full, Level: host.LevelOK}
}

// generate writes the configuration an installation needs, and nothing else.
//
// It deploys nothing. That separation is useful in its own right — an operator
// who prefers to run `docker compose` themselves gets correct, complete
// configuration without handing the installer control of their stack.
// generated is what a deploy needs to know about the configuration that was
// just written: whether an override exists (Compose must be told, and passing
// -f for a file that is not there is a hard error) and the secrets, so failure
// output can be redacted with the real values rather than a guess at their shape.
type generated struct {
	hasOverride bool
	secrets     *plan.Secrets
}

func generate(p *plan.Plan, dryRun bool, willDeploy bool) (generated, error) {
	// Refused before a single file is touched, and before secrets are even
	// resolved: a half-written installation directory for a target this build
	// cannot finish is worse than a clear refusal.
	if err := config.CheckTarget(p); err != nil {
		return generated{}, err
	}
	writer := &config.Writer{Dir: p.InstallDirectory, DryRun: dryRun}

	secrets, reused, err := resolveSecrets(p.InstallDirectory)
	if err != nil {
		return generated{}, err
	}
	if problems := secrets.Validate(); len(problems) > 0 {
		// Reached only for secrets read back from an existing .env — generated
		// ones cannot fail this. Refusing beats deploying a stack the backend
		// will reject at boot with a message about a variable the operator never
		// set by hand.
		return generated{}, fmt.Errorf("the secrets in %s/%s are not usable: %s\n"+
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

	// Recover Prowlarr's API key when this run did not generate one.
	//
	// The key is not persisted anywhere the installer can read back: it is
	// excluded from the plan JSON and never written to .env, because nothing
	// consumes it there. Prowlarr's own config.xml holds the working key, and
	// the installer never rewrites that file once it exists, so reading it back
	// is both safe and the only way a later run can finish the wiring. It also
	// recovers a key PROWLARR generated itself, which is what happens when the
	// companion is enabled on an installation whose secrets are reused.
	if p.Companions.Prowlarr && secrets != nil && secrets.ProwlarrAPIKey == "" {
		path := filepath.Join(p.InstallDirectory, config.ProwlarrConfigFileName)
		if existing, err := os.ReadFile(path); err == nil {
			secrets.ProwlarrAPIKey = companion.ParseAPIKey(string(existing))
		}
	}

	// Storage first: a bind-backed volume whose device does not exist does not
	// fail at `compose config` and is not created on demand — the container fails
	// to START, with an error naming an internal Docker path and no hint that a
	// host directory is missing. Preparing it before anything else means that
	// error cannot happen.
	if err := prepareStorage(p, dryRun); err != nil {
		return generated{}, err
	}

	actions, err := writer.EnsureDir()
	if err != nil {
		return generated{}, err
	}
	all := []config.Action{actions}

	// Before any file is written: the override binds these into containers, and
	// a bind whose device is missing fails the container's START, with an error
	// that names an internal Docker path and never mentions the directory. They
	// cannot be left to the files written into them — those are seeded only when
	// there is a new secret to seed, so turning a companion on for an existing
	// installation wrote nothing and created nothing.
	dirActions, err := writer.EnsureBoundConfigDirs(p)
	all = append(all, dirActions...)
	if err != nil {
		return generated{}, err
	}

	files := config.Render(p, secrets)
	written := make([]string, 0, len(files))
	for _, f := range files {
		acts, err := writer.Write(f)
		if err != nil {
			return generated{}, err
		}
		all = append(all, acts...)
		written = append(written, f.Name)
	}
	// A plan that no longer needs an override must not leave the previous one
	// behind: Compose would keep merging settings the operator has removed.
	if !containsName(files, config.OverrideFileName) {
		acts, err := writer.Remove(config.OverrideFileName)
		if err != nil {
			return generated{}, err
		}
		all = append(all, acts...)
	}
	// The console goes in beside the installation, not into /usr/local/bin.
	//
	// That directory is not durable everywhere — QTS runs its root filesystem
	// from RAM, so a binary placed there and the session in $HOME are both gone
	// after a reboot — while the installation directory is persistent by
	// definition; it is where .env lives. The launcher written alongside points
	// the console's configuration here for the same reason.
	if console.Available() {
		binPath, launcher, cerr := console.Install(p.InstallDirectory, dryRun)
		switch {
		case cerr != nil:
			// Never fatal: an installation without a console is still a working
			// installation, and the web UI is unaffected.
			all = append(all, config.Action{Path: binPath, Kind: "skipped",
				Detail: "could not install the console: " + cerr.Error()})
		default:
			all = append(all, config.Action{Path: launcher, Kind: "create",
				Detail: "terminal console (" + console.Name + ")"})
		}
	}

	if acts, err := writeState(writer, p, written); err != nil {
		return generated{}, err
	} else {
		all = append(all, acts...)
	}

	fmt.Println()
	for _, a := range all {
		fmt.Println("  " + a.String())
	}

	if dryRun {
		fmt.Println("\nDry run — nothing has been changed.")
		return generated{hasOverride: containsName(files, config.OverrideFileName), secrets: secrets}, nil
	}
	printNextSteps(p, reused, willDeploy)
	return generated{hasOverride: containsName(files, config.OverrideFileName), secrets: secrets}, nil
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
func printNextSteps(p *plan.Plan, reused bool, willDeploy bool) {
	env := filepath.Join(p.InstallDirectory, config.EnvFileName)
	if willDeploy {
		// install continues into deployStack; telling the operator to bring the
		// stack up themselves here would contradict what happens next.
		fmt.Printf("\nConfiguration written to %s.\n", p.InstallDirectory)
		printCredentialsNote(p, reused)
		printConsoleNote(p)
		return
	}
	fmt.Printf(`
Configuration written. Nothing has been deployed.

To bring the stack up, from the repository root:

    docker compose --env-file %s up -d

Then, once the backend is healthy, seed the first administrator:

    docker compose exec backend npx prisma db seed

The web UI will be at %s
`, env, publicAddress(p))

	printCredentialsNote(p, reused)
	printConsoleNote(p)
}

// printConsoleNote says how to run the console that was just installed.
//
// By its full path, deliberately. Putting it on PATH is not something the
// installer can do durably everywhere — the obvious directory for it, and the
// user's home, are both on a RAM filesystem under QTS — so the address that is
// always correct is the one beside the installation.
func printConsoleNote(p *plan.Plan) {
	if !console.Available() {
		return
	}
	fmt.Printf(`
A terminal console was installed with this stack. Run it with:

    %s

It signs in separately and keeps its session beside this installation, so a
reboot does not lose it.
`, filepath.Join(p.InstallDirectory, console.Name))
}

// printCredentialsNote says where the generated credentials live.
//
// Shared by both paths: it is as true after a deployment as after generating
// configuration, and duplicating it is how the two drift apart.
func printCredentialsNote(p *plan.Plan, reused bool) {
	env := filepath.Join(p.InstallDirectory, config.EnvFileName)

	if p.Torrent.Engine == plan.EngineQbittorrent {
		fmt.Printf(`
The bundled qBittorrent was seeded with its own password, so it will not print a
temporary one to its log. Both the Web UI sign-in and the credentials to give
UltraTorrent under Settings -> Integrations are in
%s
`, filepath.Join(p.InstallDirectory, config.EngineCredentialsFileName))
	}

	// An external engine is the one case where the installer deploys NOTHING for
	// the engine, so nothing it writes can wire it up: UltraTorrent stores engine
	// connections in its database, configured through the UI, not in the
	// environment. The address is asked for, recorded in the plan, and then has
	// nowhere to go but here — saying so is what stops --engine external from
	// producing a stack with no engine and no explanation.
	if p.Torrent.Engine == plan.EngineExternal {
		fmt.Printf(`
No engine was deployed: this installation uses the one already running at
%s
Add it under Settings -> Integrations, with that address and its own
credentials. Nothing else in this installation knows about it yet.
`, p.Torrent.ExternalURL)
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

// deployStack brings the configuration that generate just wrote to life.
//
// Ordering is not arbitrary. Config validates the merged file set before any
// image is fetched, so a malformed override costs a second rather than a pull.
// Build runs only when the stack actually needs a local image — backend and
// frontend have a build: and no published image, so there is no registry to
// pull them from. Pull uses --ignore-buildable for the same reason. Up waits,
// because "started" is not "healthy" and the backend applies its database
// migrations during startup.
//
// On failure it diagnoses rather than returning the exit status: `up --wait`
// failing tells an operator only that something did not become healthy, and the
// real cause — usually a failed migration — is visible only in the logs.
func deployStack(p *plan.Plan, g generated) error {
	c := &deploy.Compose{
		RepoDir:     p.RepoDirectory,
		InstallDir:  p.InstallDirectory,
		ProjectName: p.ProjectName,
		Profiles:    p.ComposeProfiles(),
		HasOverride: g.hasOverride,
		Run:         deploy.DefaultRunner(),
	}

	// Redact with the real secret values, not a pattern that guesses their
	// shape. A failed database connection prints DATABASE_URL, and a terminal
	// someone screenshots is a poor place to learn the password.
	redact := func(text string) string {
		s := g.secrets
		if s == nil {
			return text
		}
		return config.Redact(text,
			s.PostgresPassword, s.JWTAccessSecret, s.JWTRefreshSecret,
			s.EncryptionKey, s.AdminPassword, s.EnginePassword)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	fmt.Println("\nDeploying")

	if err := c.Config(ctx); err != nil {
		return err
	}
	fmt.Println("  configuration valid")

	if script, ok := c.NeedsBuild(); ok {
		current, reason := c.ImagesAreCurrent(ctx)
		switch {
		case current && !p.ForceRebuild:
			fmt.Printf("  images are up to date (%s) — skipping the build\n", reason)
		default:
			if p.ForceRebuild {
				reason = "asked for with --rebuild"
			}
			fmt.Printf("  building images — %s\n", reason)
			fmt.Printf("    (%s)\n", script)
			if err := c.Build(ctx); err != nil {
				return err
			}
		}
	}

	if msg, err := c.Pull(ctx); err != nil {
		return fmt.Errorf("pulling images: %s", msg)
	}
	fmt.Println("  images ready")

	// Before starting: a service the plan no longer deploys is still running
	// from a previous one, because Compose only acts on the services its active
	// profiles select. Left alone, the old engine keeps writing to the same
	// /downloads volume as the new one, and it holds the Web UI port the new one
	// is about to ask for — so this runs before `up`, not after it.
	if stale, err := c.StaleContainers(ctx); err != nil {
		// Not fatal. Failing a deployment because the tidying-up could not be
		// worked out would be a worse outcome than the untidiness.
		fmt.Printf("  could not check for services this plan drops (%v)\n", err)
	} else if len(stale) > 0 {
		for _, sc := range stale {
			fmt.Printf("  removing %s — not in this plan (its data is kept)\n", sc.Service)
		}
		if err := c.RemoveStale(ctx, stale); err != nil {
			return err
		}
	}

	fmt.Println("  starting services")
	if upErr := c.Up(ctx, 5*time.Minute); upErr != nil {
		d := c.Diagnose(ctx, 40, redact)
		fmt.Fprintln(os.Stderr, "\nThe stack did not become healthy.")
		for _, svc := range d.Unhealthy {
			fmt.Fprintf(os.Stderr, "\n  %s: %s\n", svc.Name, svc.State)
			// Keyed by Service, not Name: Diagnose indexes by the Compose service
			// ("backend") while Name is the container ("ultratorrent-backend-1").
			// Looking up by Name silently found nothing, so a failed deploy showed
			// the service and its state and none of the reason — which is the only
			// part worth printing.
			if tail := d.Logs[svc.Service]; tail != "" {
				for _, line := range strings.Split(strings.TrimRight(tail, "\n"), "\n") {
					fmt.Fprintln(os.Stderr, "    "+line)
				}
			}
		}
		return upErr
	}

	fmt.Println("  all services healthy")

	// Healthy is not the same as usable. The backend's CMD applies migrations
	// and stops there, so without this the stack comes up with a complete schema
	// and no users at all, and every sign-in fails.
	seedOut, err := c.Seed(ctx)
	if err != nil {
		// Only on failure, and redacted: the seed prints the administrator's
		// password on success, and it is already in a root-only file.
		fmt.Fprintln(os.Stderr, "\n"+redact(strings.TrimSpace(seedOut)))
		return err
	}
	fmt.Println("  database seeded")

	// Through the PUBLISHED web UI, not the backend's own loopback. The earlier
	// check ran inside the backend container against 127.0.0.1:4000, which
	// proves the API can talk to itself and nothing about whether anyone can
	// reach it — and it certified a deployment whose UI was returning 502 to
	// every request. A deployment is usable when its front door opens.
	adminPass := ""
	if g.secrets != nil {
		adminPass = g.secrets.AdminPassword
	}
	result := deploy.VerifySignIn(ctx, p.Networking.FrontendPort, p.Admin.Username, adminPass)
	switch {
	case result.OK:
		fmt.Println("  " + result.Explain())
	case adminPass == "":
		// Nothing to try with. Not a fault in the deployment.
		fmt.Println("  sign-in not verified (no administrator password to test with)")
	default:
		return fmt.Errorf("the deployment is running but not usable: %s", result.Explain())
	}

	wireCompanions(ctx, c, p, g)
	return nil
}

// wireCompanions finishes the setup the operator would otherwise do by hand.
//
// This installer exists so that someone who does not want to read documentation
// ends up with a working system, and "now open Settings, paste this key, then
// add FlareSolverr as an indexer proxy" is the step that loses people.
//
// Nothing here fails the deployment. The stack is running and someone can sign
// in to it; an indexer manager that still needs connecting by hand is a smaller
// problem than tearing down a working installation, so a failure is reported
// with enough detail to finish the job manually.
func wireCompanions(ctx context.Context, c *deploy.Compose, p *plan.Plan, g generated) {
	if !p.Companions.Prowlarr {
		return
	}
	key := ""
	if g.secrets != nil {
		key = g.secrets.ProwlarrAPIKey
	}
	if key == "" {
		fmt.Println("  Prowlarr is deployed but its API key is unknown — connect it under Settings -> Integrations")
		return
	}

	flare := ""
	if p.Companions.FlareSolverr {
		flare = deploy.FlareSolverrInternalURL
	}
	outcome, err := c.WireProwlarr(ctx, deploy.WireOptions{
		ProwlarrAPIKey:  key,
		ProwlarrURL:     fmt.Sprintf("http://prowlarr:%d", deploy.ProwlarrContainerPort),
		FlareSolverrURL: flare,
	})
	if err != nil {
		fmt.Printf("  could not finish connecting Prowlarr (%v) — do it under Settings -> Integrations\n", err)
		return
	}
	for _, part := range strings.Fields(outcome) {
		fmt.Println("  " + deploy.ExplainWiring(part))
	}
}
