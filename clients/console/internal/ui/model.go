package ui

import (
	"context"
	"errors"
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/ultratorrent/utconsole/internal/api"
)

// View is one tab.
//
// Each names the snapshot domains it needs, which is what lets the console hide
// a tab the account cannot read and — more importantly — ask the server for
// only the domains currently on screen. A console showing one panel must not
// make the backend build sixteen.
type View struct {
	Key     string
	Title   string
	Domains []string
}

var views = []View{
	{Key: "overview", Title: "Overview", Domains: []string{"system", "storage", "engines", "torrents", "jobs", "mediaIntake", "alerts"}},
	{Key: "torrents", Title: "Torrents", Domains: []string{"torrents", "queue"}},
	{Key: "media", Title: "Media", Domains: []string{"mediaIntake", "media", "playback"}},
	{Key: "jobs", Title: "Jobs", Domains: []string{"jobs", "automation"}},
	{Key: "acquisition", Title: "Acquisition", Domains: []string{"acquisition"}},
	{Key: "infra", Title: "Infrastructure", Domains: []string{"engines", "indexers", "providers", "storage", "system"}},
	{Key: "activity", Title: "Activity", Domains: []string{"recentActivity", "notifications"}},
	{Key: "alerts", Title: "Alerts", Domains: []string{"alerts", "system", "storage", "engines", "torrents", "jobs", "mediaIntake", "indexers", "providers"}},
}

// Model is the console's whole state.
type Model struct {
	client *api.Client
	caps   *api.Capabilities

	snapshot *api.Snapshot
	// lastErr is the most recent fetch failure. Held rather than fatal: a
	// console that quits when the server hiccups is useless precisely when the
	// server is having a bad day, so the last good snapshot stays on screen
	// with the error reported beside it.
	lastErr     error
	lastFetched time.Time
	fetching    bool

	active   int
	width    int
	height   int
	interval time.Duration
	paused   bool
	quitting bool

	// warning is a one-off notice shown until dismissed (config permissions,
	// a newer server minor, and similar).
	warning string
}

// New builds the initial model.
func New(client *api.Client, caps *api.Capabilities, interval time.Duration, warning string) Model {
	min := time.Duration(caps.Limits.MinSnapshotIntervalSeconds) * time.Second
	if min > 0 && interval < min {
		// The server publishes a floor so a client does not have to guess.
		// Honouring it here means a misconfigured console cannot become load.
		interval = min
	}
	m := Model{
		client:   client,
		caps:     caps,
		interval: interval,
		warning:  warning,
		/*
		 * A usable size before any WindowSizeMsg arrives. Bubble Tea reports
		 * the real one immediately on a normal terminal, but not every terminal
		 * is normal — a pty with no controlling terminal never sends it, and a
		 * console that waits for it renders the word "Starting…" forever. An
		 * assumed 100x30 is wrong by a few columns at worst and right enough to
		 * read; waiting is wrong in a way the operator cannot fix.
		 */
		width:  100,
		height: 30,
	}
	m.active = m.firstPermittedView()
	return m
}

type snapshotMsg struct {
	snapshot *api.Snapshot
	err      error
}

type tickMsg time.Time

// Init kicks off the first fetch immediately, then starts the clock.
func (m Model) Init() tea.Cmd {
	return tea.Batch(m.fetch(), tick(m.interval))
}

func tick(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// fetch asks for exactly the domains the current view needs.
func (m Model) fetch() tea.Cmd {
	domains := m.permittedDomainsFor(views[m.active])
	client := m.client
	return func() tea.Msg {
		if len(domains) == 0 {
			return snapshotMsg{err: errors.New("no readable panels in this view")}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		snap, err := client.Snapshot(ctx, domains, 0)
		return snapshotMsg{snapshot: snap, err: err}
	}
}

// permittedDomainsFor filters a view's domains by what this account may read.
func (m Model) permittedDomainsFor(v View) []string {
	out := make([]string, 0, len(v.Domains))
	for _, d := range v.Domains {
		if m.caps.Permits(d) {
			out = append(out, d)
		}
	}
	return out
}

// viewPermitted reports whether any of a view's domains are readable.
func (m Model) viewPermitted(v View) bool {
	return len(m.permittedDomainsFor(v)) > 0
}

func (m Model) firstPermittedView() int {
	for i, v := range views {
		if m.viewPermitted(v) {
			return i
		}
	}
	return 0
}

// Update handles input and the refresh clock.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case tickMsg:
		if m.paused || m.fetching {
			return m, tick(m.interval)
		}
		m.fetching = true
		return m, tea.Batch(m.fetch(), tick(m.interval))

	case snapshotMsg:
		m.fetching = false
		if msg.err != nil {
			m.lastErr = msg.err
			// A snapshot that failed leaves the previous one on screen. The
			// status bar carries the failure and its age, so nothing is
			// silently stale.
			return m, nil
		}
		m.lastErr = nil
		m.lastFetched = time.Now()
		m.snapshot = mergeSnapshot(m.snapshot, msg.snapshot)
		return m, nil
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		m.quitting = true
		return m, tea.Quit

	case "tab", "right", "l":
		m.active = m.nextPermitted(1)
		m.warning = ""
		return m, m.fetch()

	case "shift+tab", "left", "h":
		m.active = m.nextPermitted(-1)
		m.warning = ""
		return m, m.fetch()

	case "r":
		m.warning = ""
		if m.fetching {
			return m, nil
		}
		m.fetching = true
		return m, m.fetch()

	case "p":
		// Pausing is for reading a moving list without it moving. It stops the
		// polling entirely rather than freezing a copy, so a paused console
		// costs the server nothing at all.
		m.paused = !m.paused
		return m, nil

	case "1", "2", "3", "4", "5", "6", "7", "8":
		idx := int(msg.String()[0] - '1')
		if idx >= 0 && idx < len(views) && m.viewPermitted(views[idx]) {
			m.active = idx
			m.warning = ""
			return m, m.fetch()
		}
		return m, nil
	}
	return m, nil
}

// nextPermitted moves to the next view the account can actually read.
func (m Model) nextPermitted(step int) int {
	n := len(views)
	for i := 1; i <= n; i++ {
		idx := ((m.active+step*i)%n + n) % n
		if m.viewPermitted(views[idx]) {
			return idx
		}
	}
	return m.active
}

// mergeSnapshot keeps domains the newest fetch did not ask for.
//
// Each view requests only its own domains, so switching tabs would otherwise
// blank every panel the previous view had filled — and switching back would
// show empty boxes until the next tick. Merging keeps what is still true and
// replaces what was refetched.
func mergeSnapshot(prev, next *api.Snapshot) *api.Snapshot {
	if prev == nil || next == nil {
		return next
	}
	d := &next.Domains
	p := prev.Domains
	if d.System == nil {
		d.System = p.System
	}
	if d.Storage == nil {
		d.Storage = p.Storage
	}
	if d.Torrents == nil {
		d.Torrents = p.Torrents
	}
	if d.Queue == nil {
		d.Queue = p.Queue
	}
	if d.MediaIntake == nil {
		d.MediaIntake = p.MediaIntake
	}
	if d.Media == nil {
		d.Media = p.Media
	}
	if d.Playback == nil {
		d.Playback = p.Playback
	}
	if d.Jobs == nil {
		d.Jobs = p.Jobs
	}
	if d.Automation == nil {
		d.Automation = p.Automation
	}
	if d.Acquisition == nil {
		d.Acquisition = p.Acquisition
	}
	if d.Engines == nil {
		d.Engines = p.Engines
	}
	if d.Indexers == nil {
		d.Indexers = p.Indexers
	}
	if d.Providers == nil {
		d.Providers = p.Providers
	}
	if d.Notifications == nil {
		d.Notifications = p.Notifications
	}
	if d.RecentActivity == nil {
		d.RecentActivity = p.RecentActivity
	}
	if d.Alerts == nil {
		d.Alerts = p.Alerts
	}
	return next
}

// statusLine is the bottom bar: what is true, and how old it is.
func (m Model) statusLine() string {
	if m.lastErr != nil {
		age := "never"
		if !m.lastFetched.IsZero() {
			age = humanDuration(time.Since(m.lastFetched)) + " old"
		}
		return styleErr.Render(fmt.Sprintf("⚠ %v — showing data %s", m.lastErr, age))
	}
	state := "live"
	if m.paused {
		state = "paused"
	}
	cost := ""
	if m.snapshot != nil {
		cost = fmt.Sprintf(" · built in %dms", m.snapshot.DurationMs)
	}
	return styleMuted.Render(fmt.Sprintf(
		"%s · refreshed %s · every %s%s",
		state, ago(ptr(m.lastFetched.Format(time.RFC3339))), humanDuration(m.interval), cost,
	))
}

func ptr[T any](v T) *T { return &v }
