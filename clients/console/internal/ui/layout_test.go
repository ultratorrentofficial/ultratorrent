package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/api"
)

// Layout has one hard requirement: nothing may exceed the width it was given.
// A pane that overflows wraps, and a wrapped border tears every box below it —
// which is invisible in a unit test of the content and obvious on a terminal.

func TestPanelIsExactlyTheWidthAsked(t *testing.T) {
	for _, width := range []int{20, 46, 60, 100, 150} {
		p := panel("Storage", "a line\nanother line", width)
		for i, line := range strings.Split(p, "\n") {
			if got := lipgloss.Width(line); got != width {
				t.Errorf("width %d: line %d is %d wide:\n%q", width, i, got, line)
			}
		}
	}
}

func TestPanelHandlesStyledContentWithoutTearing(t *testing.T) {
	// Styled text carries escape bytes that len() counts and terminals do not.
	// Measuring with len() here would silently narrow every coloured row.
	body := styleErr.Render("errored") + " " + styleOK.Render("healthy")
	p := panel("Engines", body, 50)
	for _, line := range strings.Split(p, "\n") {
		if got := lipgloss.Width(line); got != 50 {
			t.Fatalf("styled content broke the frame: %d wide\n%q", got, line)
		}
	}
}

func TestPanelTruncatesOverlongContent(t *testing.T) {
	long := strings.Repeat("x", 500)
	p := panel("Title", long, 40)
	for _, line := range strings.Split(p, "\n") {
		if got := lipgloss.Width(line); got != 40 {
			t.Fatalf("overlong content escaped the frame: %d wide", got)
		}
	}
}

func TestPanelTitleSurvivesANarrowPane(t *testing.T) {
	// The title is truncated rather than allowed to push the corner off.
	p := panel("A very long pane title indeed", "x", 20)
	first := strings.Split(p, "\n")[0]
	if lipgloss.Width(first) != 20 {
		t.Errorf("top rail = %d wide, want 20: %q", lipgloss.Width(first), first)
	}
	if !strings.HasSuffix(strings.TrimRight(first, " "), cornerTR) {
		t.Errorf("top rail lost its corner: %q", first)
	}
}

func TestColumnsAlignAtEqualHeight(t *testing.T) {
	short := panel("Short", "one", 40)
	tall := panel("Tall", "one\ntwo\nthree\nfour", 40)
	joined := columns(1, short, tall)

	lines := strings.Split(joined, "\n")
	if len(lines) != lipgloss.Height(tall) {
		t.Fatalf("joined height = %d, want %d", len(lines), lipgloss.Height(tall))
	}
	// Every row must be the full combined width, or the next block starts ragged.
	want := 40 + 1 + 40
	for i, line := range lines {
		if got := lipgloss.Width(line); got != want {
			t.Errorf("row %d is %d wide, want %d:\n%q", i, got, want, line)
		}
	}
}

func TestSplitWidthRefusesToCramp(t *testing.T) {
	// Two columns on a narrow terminal truncate every value they hold.
	if cols := splitWidth(80, 2, 1); cols != nil {
		t.Errorf("80 columns should stay single-column, got %v", cols)
	}
	cols := splitWidth(150, 2, 1)
	if cols == nil {
		t.Fatal("150 columns should split")
	}
	// The grid must reach the right edge; a leftover gutter reads as a bug.
	if cols[0]+cols[1]+1 != 150 {
		t.Errorf("columns %v do not fill 150", cols)
	}
}

func TestFullScreenNeverExceedsTheTerminalWidth(t *testing.T) {
	// The property that matters end to end, across every view and both layouts.
	for _, width := range []int{72, 100, 120, 150, 200} {
		m := testModel(width)
		for i := range views {
			m.active = i
			for n, line := range strings.Split(m.View(), "\n") {
				if got := lipgloss.Width(line); got > width {
					t.Errorf("view %q at width %d: line %d is %d wide\n%q",
						views[i].Key, width, n, got, line)
				}
			}
		}
	}
}

func TestNarrowTerminalFallsBackToOneColumn(t *testing.T) {
	narrow := testModel(80)
	narrow.active = 0
	if strings.Contains(narrow.View(), cornerTR+" "+cornerTL) {
		t.Error("80 columns should not render two panes side by side")
	}

	wide := testModel(150)
	wide.active = 0
	// Two top rails on one line is the signature of a grid.
	if !strings.Contains(wide.View(), cornerTR+" "+cornerTL) {
		t.Error("150 columns should render a two-column grid")
	}
}

// testModel builds a model with a fully-populated snapshot.
func testModel(width int) Model {
	pct := 42.0
	caps := &api.Capabilities{
		PermittedDomains: []string{
			"system", "storage", "torrents", "queue", "mediaIntake", "media",
			"playback", "jobs", "automation", "acquisition", "engines",
			"indexers", "providers", "notifications", "recentActivity", "alerts",
		},
	}
	caps.Server.Product = "UltraTorrent"
	caps.Server.Version = "0.85.8"
	caps.User.Username = "operator"
	caps.User.Roles = []string{"READ_ONLY"}

	m := New(nil, caps, 5, "")
	m.width, m.height = width, 44

	snap := &api.Snapshot{ContractVersion: "1.1.0"}
	snap.Domains.System = &api.Domain[api.System]{Available: true, Data: api.System{
		LoadAverage: []float64{1.5, 1, 1}, CPUCount: 4, Database: api.HealthHealthy,
	}}
	snap.Domains.Storage = &api.Domain[api.Storage]{Available: true, Data: api.Storage{
		Roots: []api.StorageRoot{{Path: "/downloads", UsedPercent: &pct, Health: api.HealthHealthy}},
	}}
	snap.Domains.Torrents = &api.Domain[api.Torrents]{Available: true, Data: api.Torrents{
		Active: []api.Torrent{{
			Name:  strings.Repeat("A very long release name that will not fit ", 3),
			State: "downloading", Progress: 0.5,
		}},
	}}
	snap.Domains.Queue = &api.Domain[api.Queue]{Available: false, Reason: "forbidden"}
	snap.Domains.MediaIntake = &api.Domain[api.MediaIntake]{Available: true, Data: api.MediaIntake{
		Recent: []api.IntakeJob{{Title: strings.Repeat("long title ", 12), State: "importing"}},
	}}
	snap.Domains.Media = &api.Domain[api.Media]{Available: true, Data: api.Media{TotalItems: 10}}
	snap.Domains.Playback = &api.Domain[api.Playback]{Available: true, Data: api.Playback{
		Sessions: []api.PlaybackSession{{User: "ana", Title: strings.Repeat("film ", 20), Progress: 0.3}},
	}}
	snap.Domains.Jobs = &api.Domain[api.Jobs]{Available: true, Data: api.Jobs{
		Recent: []api.Job{{Type: strings.Repeat("job.type.", 8), Status: "failed"}},
	}}
	snap.Domains.Automation = &api.Domain[api.Automation]{Available: true, Data: api.Automation{
		RecentRuns: []api.AutomationRun{{RuleName: strings.Repeat("rule ", 10), Result: "failed"}},
	}}
	snap.Domains.Acquisition = &api.Domain[api.Acquisition]{Available: true, Data: api.Acquisition{
		Recent: []api.AcquisitionEvent{{ReleaseTitle: strings.Repeat("release ", 12), Result: "matched"}},
	}}
	snap.Domains.Engines = &api.Domain[[]api.Engine]{Available: true, Data: []api.Engine{
		{EngineID: "engine-with-a-long-id", Kind: "qbittorrent", Health: api.HealthDown},
	}}
	snap.Domains.Indexers = &api.Domain[[]api.Indexer]{Available: true, Data: []api.Indexer{
		{Name: strings.Repeat("indexer ", 8), Health: api.HealthDown},
	}}
	snap.Domains.Providers = &api.Domain[[]api.Provider]{Available: true, Data: []api.Provider{
		{Name: "Plex", Category: "media_server", Health: api.HealthDegraded},
	}}
	snap.Domains.Notifications = &api.Domain[api.Notifications]{Available: true}
	snap.Domains.RecentActivity = &api.Domain[[]api.ActivityItem]{Available: true, Data: []api.ActivityItem{
		{Message: strings.Repeat("something happened ", 10), Level: "error", EventCount: 3, At: "2026-08-22T12:00:00Z"},
	}}
	snap.Domains.Alerts = &api.Domain[[]api.Alert]{Available: true, Data: []api.Alert{
		{Severity: api.SeverityCritical, Domain: "storage", Title: strings.Repeat("alert ", 20)},
	}}
	m.snapshot = snap
	return m
}
