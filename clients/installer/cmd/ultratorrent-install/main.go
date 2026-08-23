// Command ultratorrent-install deploys and maintains an UltraTorrent stack.
//
// Phase 2 scope: the plan model and the commands that only read it. `plan` and
// `install --dry-run` produce and print an InstallationPlan and stop. Nothing
// here writes a file, contacts a network, or runs Docker — and that is enforced
// by construction rather than by care, because the packages that could do those
// things do not exist yet.
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/ultratorrent/installer/internal/plan"
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
  --prowlarr          Deploy the Prowlarr indexer manager
  --flaresolverr      Deploy FlareSolverr (requires --prowlarr)

Not yet implemented in this build: the interactive wizard, host detection, and
every command that changes the system. This build can only plan.
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
		p, err := build(*installDir, *port, *engine, *mediaRoot, *withProwlarr, *withFlare)
		if err != nil {
			return err
		}
		return emit(p, *asJSON, *output)

	case "install":
		p, err := build(*installDir, *port, *engine, *mediaRoot, *withProwlarr, *withFlare)
		if err != nil {
			return err
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
		// one that refuses.
		return fmt.Errorf(
			"this build can plan but not deploy — run with --dry-run to preview the plan")

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
func build(installDir string, port int, engine, mediaRoot string, prowlarr, flare bool) (*plan.Plan, error) {
	p := plan.Recommended(version)
	p.InstallDirectory = installDir
	p.Networking.FrontendPort = port
	p.Torrent.Engine = plan.Engine(engine)

	if mediaRoot != "" {
		p.Storage.Mode = plan.StorageBind
		p.Storage.MediaRoot = mediaRoot
	}
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
