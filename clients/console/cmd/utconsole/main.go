// Command utconsole is UltraTorrent's terminal observability client.
//
// It reads. It does not manage. Every request it makes is a GET against the
// operations surface, authenticated as an ordinary account, and the server
// refuses anything else regardless of what this binary asks for — read-only is
// a property of the account and the API, not a promise made by this program.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/term"

	"github.com/ultratorrent/utconsole/internal/api"
	"github.com/ultratorrent/utconsole/internal/config"
	"github.com/ultratorrent/utconsole/internal/realtime"
	"github.com/ultratorrent/utconsole/internal/ui"
)

// Set by the linker: -ldflags "-X main.version=… -X main.commit=…".
var (
	version = "dev"
	commit  = "unknown"
	built   = "unknown"
)

const usage = `UltraTorrent Console — a read-only terminal view of a running install.

Usage:
  utconsole [flags]              Run the console
  utconsole login [flags]        Authenticate and store the session
  utconsole logout               Forget the stored session
  utconsole snapshot [flags]     Print one snapshot as JSON and exit
  utconsole version              Print build information

Flags:
  --server URL     Server root, e.g. https://ut.example.com
  --user NAME      Username (login only; prompted when omitted)
  --totp CODE      Two-factor code, when the account requires one
  --interval SECS  Refresh interval for the console (default 5)
  --domains LIST   Comma-separated domains (snapshot only)
  --timeout SECS   HTTP timeout (default 30)
  --insecure-echo  Read the password from stdin without a TTY (scripts only)

Configuration lives in %s and holds a rotating refresh token; keep it 0600.
`

func main() {
	if err := run(); err != nil {
		if errors.Is(err, api.ErrUnauthorized) {
			fmt.Fprintln(os.Stderr, "Not signed in, or the stored session expired. Run: utconsole login --server <url>")
			os.Exit(2)
		}
		if errors.Is(err, api.ErrForbidden) {
			fmt.Fprintln(os.Stderr, "This account may not use the console. It needs the console.view permission.")
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, "utconsole: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	cmd := ""
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}

	fs := flag.NewFlagSet("utconsole", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var (
		server   = fs.String("server", "", "server root URL")
		user     = fs.String("user", "", "username")
		totp     = fs.String("totp", "", "two-factor code")
		interval = fs.Int("interval", 0, "refresh interval, seconds")
		domains  = fs.String("domains", "", "comma-separated domains")
		timeout  = fs.Int("timeout", 30, "HTTP timeout, seconds")
		insecure = fs.Bool("insecure-echo", false, "read password from stdin without a TTY")
		help     = fs.Bool("help", false, "show usage")
	)
	fs.Usage = func() { printUsage() }
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *help || cmd == "help" {
		printUsage()
		return nil
	}
	if cmd == "version" {
		fmt.Printf("utconsole %s (%s, built %s), operations contract %d.x\n", version, commit, built, api.ContractMajor)
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if *server != "" {
		cfg.ServerURL = strings.TrimRight(*server, "/")
	}
	if *interval > 0 {
		cfg.RefreshSeconds = *interval
	}
	if cfg.ServerURL == "" {
		return errors.New("no server configured — pass --server https://your-install")
	}

	client := api.New(cfg.ServerURL, time.Duration(*timeout)*time.Second)
	// Persist every rotation immediately. A refresh token is single-use: losing
	// the new one means the stored session is already dead.
	client.OnRefresh(func(token string) {
		cfg.RefreshToken = token
		if err := cfg.Save(); err != nil {
			fmt.Fprintln(os.Stderr, "warning: could not save the rotated session: "+err.Error())
		}
	})

	switch cmd {
	case "login":
		return doLogin(client, cfg, *user, *totp, *insecure)
	case "logout":
		if err := cfg.Clear(); err != nil {
			return err
		}
		fmt.Println("Signed out. The server-side token was not revoked; it expires on its own.")
		return nil
	case "snapshot":
		client.SetRefreshToken(cfg.RefreshToken)
		return doSnapshot(client, *domains)
	case "":
		client.SetRefreshToken(cfg.RefreshToken)
		return doConsole(client, cfg)
	default:
		printUsage()
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func printUsage() {
	path, err := config.Path()
	if err != nil {
		path = "the user config directory"
	}
	fmt.Fprintf(os.Stderr, usage, path)
}

// doLogin authenticates and stores the rotating refresh token.
func doLogin(client *api.Client, cfg *config.Config, user, totp string, insecure bool) error {
	reader := bufio.NewReader(os.Stdin)
	if user == "" {
		user = cfg.Username
	}
	if user == "" {
		fmt.Print("Username: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		user = strings.TrimSpace(line)
	}

	password, err := readPassword(reader, insecure)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := client.Login(ctx, user, password, totp); err != nil {
		return err
	}

	// Confirm the account can actually use the console BEFORE reporting
	// success. "Logged in" followed by a 403 on the first render would send
	// someone hunting for a bug in the console rather than asking for a grant.
	caps, err := client.Capabilities(ctx)
	if err != nil {
		return err
	}

	cfg.Username = user
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Printf("Signed in to %s as %s.\n", cfg.ServerURL, user)
	fmt.Printf("Readable panels: %d of %d.\n", len(caps.PermittedDomains), len(caps.AvailableDomains))
	if len(caps.PermittedDomains) < len(caps.AvailableDomains) {
		fmt.Println("Domains this account cannot read: " + strings.Join(missing(caps), ", "))
	}
	if w := cfg.Warn(); w != "" {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
	return nil
}

func missing(caps *api.Capabilities) []string {
	out := make([]string, 0)
	for _, d := range caps.AvailableDomains {
		if !caps.Permits(d) {
			out = append(out, d)
		}
	}
	return out
}

// readPassword reads without echoing, which needs a real terminal.
//
// The --insecure-echo escape hatch exists for scripted setup on a host with no
// TTY. It is named for what it costs: the password is read in the clear from
// stdin, so it will sit in whatever history or log fed it.
func readPassword(reader *bufio.Reader, insecure bool) (string, error) {
	fd := int(syscall.Stdin)
	if term.IsTerminal(fd) {
		fmt.Print("Password: ")
		raw, err := term.ReadPassword(fd)
		fmt.Println()
		return string(raw), err
	}
	if !insecure {
		return "", errors.New("no terminal for a password prompt; pass --insecure-echo to read it from stdin")
	}
	line, err := reader.ReadString('\n')
	return strings.TrimSpace(line), err
}

// doSnapshot prints one reading as JSON.
//
// Exists so the console is useful in a pipeline and in a bug report, not only
// on a screen — and because it is the smallest thing that proves a deployment
// works end to end.
func doSnapshot(client *api.Client, domains string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var list []string
	if domains != "" {
		for _, d := range strings.Split(domains, ",") {
			if d = strings.TrimSpace(d); d != "" {
				list = append(list, d)
			}
		}
	}
	if _, err := client.Capabilities(ctx); err != nil {
		return err
	}
	snap, err := client.Snapshot(ctx, list, 0)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(snap)
}

// doConsole runs the interactive view.
func doConsole(client *api.Client, cfg *config.Config) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	caps, err := client.Capabilities(ctx)
	if err != nil {
		// An incompatible contract still carries capabilities, so the message
		// can name both versions instead of just refusing.
		if errors.Is(err, api.ErrIncompatible) {
			return err
		}
		return err
	}
	if len(caps.PermittedDomains) == 0 {
		return errors.New("this account holds console.view but no domain permissions — there is nothing it may display")
	}

	warning := cfg.Warn()
	model := ui.New(client, caps, time.Duration(cfg.RefreshSeconds)*time.Second, warning)
	program := tea.NewProgram(model, tea.WithAltScreen())

	/*
	 * The listener outlives any single Bubble Tea command, so it runs as a
	 * goroutine that pushes into the program rather than as a tea.Cmd — those
	 * are one-shot, and a stream modelled as one would have to re-subscribe on
	 * every event.
	 *
	 * `caps.EventChannel` rather than a constant: the server names its own
	 * channel in the handshake, so a rename is a server-side change the console
	 * follows instead of a version mismatch it has to be rebuilt for.
	 */
	streamCtx, stopStream := context.WithCancel(context.Background())
	defer stopStream()
	if caps.EventChannel != "" {
		listener := realtime.New(cfg.ServerURL, caps.EventChannel, client.AccessToken)
		updates := make(chan realtime.Update, 64)
		go listener.Run(streamCtx, updates)
		go func() {
			for u := range updates {
				program.Send(ui.StreamMsg{Update: u})
			}
		}()
	}

	_, err = program.Run()
	return err
}
