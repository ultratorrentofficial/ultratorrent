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
	"github.com/ultratorrent/utconsole/internal/i18n"
	"github.com/ultratorrent/utconsole/internal/realtime"
	"github.com/ultratorrent/utconsole/internal/ui"
)

// Set by the linker: -ldflags "-X main.version=… -X main.commit=…".
var (
	version = "dev"
	commit  = "unknown"
	built   = "unknown"
)

func main() {
	if err := run(); err != nil {
		if errors.Is(err, api.ErrUnauthorized) {
			fmt.Fprintln(os.Stderr, i18n.T("cli.notSignedIn"))
			os.Exit(2)
		}
		if errors.Is(err, api.ErrForbidden) {
			fmt.Fprintln(os.Stderr, i18n.T("cli.forbidden"))
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
		locale   = fs.String("locale", "", "language tag, e.g. es-PR")
		insecure = fs.Bool("insecure-echo", false, "read password from stdin without a TTY")
		help     = fs.Bool("help", false, "show usage")
	)
	fs.Usage = func() { printUsage() }
	if err := fs.Parse(args); err != nil {
		return err
	}

	/*
	 * Language is settled before anything is printed, and settled twice: once
	 * from the flag and the environment, so `--help` and any early failure are
	 * already in the right language, and again once the config is loaded, since
	 * the stored preference cannot be read before that.
	 */
	i18n.Use(i18n.Detect(*locale, ""))
	if *locale != "" && i18n.Match(*locale) == "" {
		// Said rather than silently ignored: a typo in a language tag that
		// quietly renders English looks like the translation is missing.
		warn(i18n.T("cli.unknownLocale", *locale, i18n.Current()))
	}

	if *help || cmd == "help" {
		printUsage()
		return nil
	}
	if cmd == "version" {
		fmt.Println(i18n.T("cli.version", version, commit, built, api.ContractMajor))
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	i18n.Use(i18n.Detect(*locale, cfg.Locale))
	if *server != "" {
		cfg.ServerURL = strings.TrimRight(*server, "/")
	}
	if *interval > 0 {
		cfg.RefreshSeconds = *interval
	}
	if cfg.ServerURL == "" {
		return errors.New(i18n.T("cli.noServer"))
	}

	client := api.New(cfg.ServerURL, time.Duration(*timeout)*time.Second)
	// Persist every rotation immediately. A refresh token is single-use: losing
	// the new one means the stored session is already dead.
	client.OnRefresh(func(token string) {
		cfg.RefreshToken = token
		if err := cfg.Save(); err != nil {
			warn(i18n.T("cli.rotateFailed", err.Error()))
		}
	})

	switch cmd {
	case "login":
		return doLogin(client, cfg, *user, *totp, *insecure)
	case "logout":
		if err := cfg.Clear(); err != nil {
			return err
		}
		fmt.Println(i18n.T("cli.signedOut"))
		return nil
	case "snapshot":
		client.SetRefreshToken(cfg.RefreshToken)
		return doSnapshot(client, *domains)
	case "":
		client.SetRefreshToken(cfg.RefreshToken)
		return doConsole(client, cfg)
	default:
		printUsage()
		return errors.New(i18n.T("cli.unknownCommand", cmd))
	}
}

func printUsage() {
	path, err := config.Path()
	if err != nil {
		path = i18n.T("cli.configDir")
	}
	codes := make([]string, 0, len(i18n.Locales))
	for _, loc := range i18n.Locales {
		codes = append(codes, loc.Code)
	}
	fmt.Fprint(os.Stderr, i18n.T("cli.usage", path, strings.Join(codes, ", ")))
}

// warn prints an advisory to stderr, where it cannot be mistaken for output.
//
// stderr precisely so `utconsole snapshot | jq` keeps working when one fires.
func warn(message string) {
	fmt.Fprintln(os.Stderr, i18n.T("cli.warning", message))
}

// doLogin authenticates and stores the rotating refresh token.
func doLogin(client *api.Client, cfg *config.Config, user, totp string, insecure bool) error {
	reader := bufio.NewReader(os.Stdin)
	if user == "" {
		user = cfg.Username
	}
	if user == "" {
		fmt.Print(i18n.T("cli.promptUsername"))
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
	fmt.Println(i18n.T("cli.signedIn", cfg.ServerURL, user))
	fmt.Println(i18n.T("cli.readablePanels", len(caps.PermittedDomains), len(caps.AvailableDomains)))
	if len(caps.PermittedDomains) < len(caps.AvailableDomains) {
		fmt.Println(i18n.T("cli.deniedDomains", strings.Join(missing(caps), ", ")))
	}
	if w := cfg.Warn(); w != "" {
		warn(w)
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
		fmt.Print(i18n.T("cli.promptPassword"))
		raw, err := term.ReadPassword(fd)
		fmt.Println()
		return string(raw), err
	}
	if !insecure {
		return "", errors.New(i18n.T("cli.noTerminal"))
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
		return errors.New(i18n.T("cli.noDomains"))
	}

	warning := cfg.Warn()
	/*
	 * A language chosen with the L key is remembered, because the alternative
	 * is choosing it again on every launch — and this is a program someone
	 * opens repeatedly during an incident. The write is best-effort: it is a
	 * display preference, and failing to record one is not worth interrupting
	 * a console someone is watching a machine through.
	 */
	model := ui.New(client, caps, time.Duration(cfg.RefreshSeconds)*time.Second, warning).
		OnLocaleChange(func(code string) {
			cfg.Locale = code
			_ = cfg.Save()
		})
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
