package ui

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"github.com/ultratorrent/utconsole/internal/api"
)

// TestMain pins a colour profile for the whole package.
//
// Under `go test` there is no terminal, so lipgloss detects "no colour" and
// renders every style as plain text — which would make any assertion about
// colour vacuously pass. Pinning ANSI-256 makes the styling real and testable,
// and matches what the console actually emits over SSH.
// plain strips styling so an assertion can talk about what is drawn.
//
// Necessary once a colour profile is pinned: a rail that ends in `╮` ends in
// `╮\x1b[0m` on the wire, and comparing raw strings tests the escape sequence
// rather than the glyph.
func plain(s string) string { return ansiPattern.ReplaceAllString(s, "") }

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestMain(m *testing.M) {
	lipgloss.SetColorProfile(termenv.ANSI256)
	os.Exit(m.Run())
}

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
	if !strings.HasSuffix(strings.TrimRight(plain(first), " "), cornerTR) {
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
	if strings.Contains(plain(narrow.View()), cornerTR+" "+cornerTL) {
		t.Error("80 columns should not render two panes side by side")
	}

	wide := testModel(150)
	wide.active = 0
	// Two top rails on one line is the signature of a grid.
	if !strings.Contains(plain(wide.View()), cornerTR+" "+cornerTL) {
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
	// Enough rows that a view WILL overflow unless it budgets its height —
	// a fixture with one row would pass the height test for the wrong reason.
	many := func(n int) []api.Torrent {
		out := make([]api.Torrent, n)
		for i := range out {
			out[i] = api.Torrent{
				Name:  strings.Repeat("A very long release name that will not fit ", 3),
				State: "seeding", Progress: 1, UploadRate: 2048,
			}
		}
		return out
	}
	snap.Domains.Torrents = &api.Domain[api.Torrents]{Available: true, Data: api.Torrents{
		Active: many(25), Attention: many(12), Truncated: true,
	}}
	snap.Domains.Queue = &api.Domain[api.Queue]{Available: false, Reason: "forbidden"}
	intake := make([]api.IntakeJob, 25)
	failed := "hardlink failed: EXDEV"
	for i := range intake {
		intake[i] = api.IntakeJob{
			SourceName: strings.Repeat("staged.release.name.", 4), State: "failed",
			UpdatedAt: "2026-08-22T12:00:00Z", LastError: &failed,
		}
	}
	snap.Domains.MediaIntake = &api.Domain[api.MediaIntake]{Available: true, Data: api.MediaIntake{
		Recent: intake,
	}}
	snap.Domains.Media = &api.Domain[api.Media]{Available: true, Data: api.Media{TotalItems: 10}}
	viewer, method, pct2 := "ana", "transcode (hevc)", 30.0
	snap.Domains.Playback = &api.Domain[api.Playback]{Available: true, Data: api.Playback{
		Sessions: []api.PlaybackSession{{
			Viewer: &viewer, Title: strings.Repeat("film ", 20),
			PlaybackMethod: &method, ProgressPercent: &pct2,
		}},
	}}
	jobs := make([]api.Job, 25)
	code := "E_SCAN"
	for i := range jobs {
		jobs[i] = api.Job{
			Type: strings.Repeat("job.type.", 8), Status: "failed",
			CreatedAt: "2026-08-22T12:00:00Z", ErrorCode: &code,
		}
	}
	snap.Domains.Jobs = &api.Domain[api.Jobs]{Available: true, Data: api.Jobs{Recent: jobs}}
	snap.Domains.Automation = &api.Domain[api.Automation]{Available: true, Data: api.Automation{
		RecentRuns: []api.AutomationRun{{
			RuleName: strings.Repeat("rule ", 10), Status: "failed", At: "2026-08-22T12:00:00Z",
		}},
	}}
	acq := api.Acquisition{}
	for i := 0; i < 25; i++ {
		acq.Recent = append(acq.Recent, api.AcquisitionEvent{
			ReleaseTitle: strings.Repeat("release ", 12), Result: "matched", At: "2026-08-22T12:00:00Z",
		})
	}
	snap.Domains.Acquisition = &api.Domain[api.Acquisition]{Available: true, Data: acq}
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
	activity := make([]api.ActivityItem, 25)
	detail := strings.Repeat("from → to ", 8)
	for i := range activity {
		activity[i] = api.ActivityItem{
			Message: strings.Repeat("something happened ", 10), Level: "error",
			EventCount: 3, At: "2026-08-22T12:00:00Z", Detail: &detail,
		}
	}
	snap.Domains.RecentActivity = &api.Domain[[]api.ActivityItem]{Available: true, Data: activity}
	snap.Domains.Alerts = &api.Domain[[]api.Alert]{Available: true, Data: []api.Alert{
		{Severity: api.SeverityCritical, Domain: "storage", Title: strings.Repeat("alert ", 20)},
	}}
	m.snapshot = snap
	return m
}

func TestFullScreenNeverExceedsTheTerminalHeight(t *testing.T) {
	/*
	 * The complaint this exists for: "many pages where the top nav bar is lost
	 * due to the page scrolling". A screen taller than the terminal scrolls, the
	 * header and tab rail go off the top, and switching views then looks like a
	 * dead keyboard because nothing visibly changes.
	 */
	for _, size := range []struct{ w, h int }{{150, 44}, {120, 30}, {100, 24}, {80, 20}, {200, 60}} {
		m := testModel(size.w)
		m.height = size.h
		for i := range views {
			m.active = i
			got := len(strings.Split(m.View(), "\n"))
			if got > size.h {
				t.Errorf("view %q at %dx%d rendered %d lines — it will scroll",
					views[i].Key, size.w, size.h, got)
			}
		}
	}
}

func TestHeaderAndTabsSurviveAShortTerminal(t *testing.T) {
	// Whatever else is dropped, the two rows that say where you are must stay.
	m := testModel(120)
	m.height = 12
	m.active = 1
	lines := strings.Split(m.View(), "\n")
	if len(lines) < 2 {
		t.Fatal("the screen collapsed entirely")
	}
	if !strings.Contains(lines[0], "UltraTorrent Console") {
		t.Errorf("header missing from the first row: %q", lines[0])
	}
	if !strings.Contains(lines[1], "Overview") {
		t.Errorf("tab rail missing from the second row: %q", lines[1])
	}
}

func TestCapBodySaysWhatItHid(t *testing.T) {
	body := strings.Join([]string{"a", "b", "c", "d", "e", "f"}, "\n")
	out := capBody(body, 3)
	lines := strings.Split(out, "\n")
	if len(lines) != 3 {
		t.Fatalf("capBody returned %d lines, want 3", len(lines))
	}
	// A list that silently stops reads as the whole list.
	if !strings.Contains(lines[2], "more line") {
		t.Errorf("the cap must be announced, got %q", lines[2])
	}
	if capBody("one\ntwo", 5) != "one\ntwo" {
		t.Error("content within budget must be untouched")
	}
}

func TestWidthHelpersMeasureVisibleWidthNotBytes(t *testing.T) {
	/*
	 * The "box lines are displaced" bug. A styled string carries escape bytes a
	 * terminal never draws; measuring them as characters pads the cell as though
	 * it were far wider than it looks, shifting every column after it and landing
	 * the pane's right rail in the middle of the text.
	 */
	styled := styleErr.Render("fail")
	if lipgloss.Width(styled) != 4 {
		t.Fatalf("precondition: styled width = %d, want 4", lipgloss.Width(styled))
	}
	if got := lipgloss.Width(pad(styled, 10)); got != 10 {
		t.Errorf("pad(styled, 10) has visible width %d, want 10", got)
	}
	if got := lipgloss.Width(padLeft(styled, 10)); got != 10 {
		t.Errorf("padLeft(styled, 10) has visible width %d, want 10", got)
	}
	if got := lipgloss.Width(truncate(styleOK.Render("abcdefghij"), 5)); got > 5 {
		t.Errorf("truncate(styled, 5) has visible width %d, want <= 5", got)
	}
}

func TestMeterSensesAreOpposite(t *testing.T) {
	/*
	 * A full disk is bad; a finished download is good. Sharing one function got
	 * this exactly backwards on real data — every seeding torrent rendered its
	 * 100% bar in alarm red.
	 */
	fullDisk := meterFor(1.0, 6)
	doneDownload := progressMeter(1.0, 6)
	if fullDisk == doneDownload {
		t.Fatal("a full disk and a completed download must not render the same")
	}
	if !strings.Contains(doneDownload, "\x1b") {
		t.Fatal("precondition: the meter should be styled in tests")
	}
	// Same glyphs, different colour — the shape is a proportion either way.
	if lipgloss.Width(fullDisk) != lipgloss.Width(doneDownload) {
		t.Error("both meters should occupy the same width")
	}
}

func TestTorrentRowsFitTheirPane(t *testing.T) {
	// The row is built from styled cells; if any of them mis-measures, the row
	// overflows the frame and the border tears.
	m := testModel(150)
	rows := m.torrentTable([]api.Torrent{{
		Name: strings.Repeat("very long release name ", 6), State: "seeding",
		Progress: 1, DownloadRate: 1024, UploadRate: 2048, Stalled: false,
	}}, 146)
	for i, line := range strings.Split(rows, "\n") {
		if got := lipgloss.Width(line); got > 146 {
			t.Errorf("row %d is %d wide, want <= 146", i, got)
		}
	}
}
