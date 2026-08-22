package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/ultratorrent/utconsole/internal/api"
)

func TestHumanBytes(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KB"},
		{1536, "1.5 KB"},
		// Above ten, the decimal is noise: nobody reads "941.7 GB" differently
		// from "942 GB".
		{15 * 1024, "15 KB"},
		{1024 * 1024, "1.0 MB"},
		{5 * 1024 * 1024 * 1024, "5.0 GB"},
		{-1, "-"},
	}
	for _, c := range cases {
		if got := humanBytes(c.in); got != c.want {
			t.Errorf("humanBytes(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHumanRateBlanksIdle(t *testing.T) {
	// A column of "0 B/s" hides the rows that are actually moving.
	if got := humanRate(0); got != "" {
		t.Errorf("humanRate(0) = %q, want empty", got)
	}
	if got := humanRate(2048); got != "2.0 KB/s" {
		t.Errorf("humanRate(2048) = %q", got)
	}
}

func TestHumanETADistinguishesNeverFromUnknown(t *testing.T) {
	if got := humanETA(nil); got != "" {
		t.Errorf("unknown ETA should render empty, got %q", got)
	}
	neg := int64(-1)
	if got := humanETA(&neg); got != "∞" {
		t.Errorf("a negative ETA means 'not at this rate', got %q", got)
	}
	// Engines report absurd numbers rather than a sentinel; rendering "8y" as
	// if it were a real estimate is worse than saying never.
	huge := int64(400 * 24 * 3600)
	if got := humanETA(&huge); got != "∞" {
		t.Errorf("an ETA beyond a year should render as never, got %q", got)
	}
	hour := int64(3600)
	if got := humanETA(&hour); got != "1h 0m" {
		t.Errorf("humanETA(3600) = %q", got)
	}
}

func TestAgoHandlesClockSkew(t *testing.T) {
	future := time.Now().Add(2 * time.Minute).Format(time.RFC3339)
	// The console's host and the server's need not agree. A negative age would
	// look like a platform bug rather than a disagreement about the time.
	if got := ago(&future); got != "just now" {
		t.Errorf("a future timestamp should read as just now, got %q", got)
	}
	if got := ago(nil); got != "never" {
		t.Errorf("ago(nil) = %q, want never", got)
	}
	bad := "not-a-timestamp"
	if got := ago(&bad); got != "?" {
		t.Errorf("an unparseable timestamp should not panic or lie, got %q", got)
	}
}

func TestTruncateCountsRunesNotBytes(t *testing.T) {
	// A release title with accents must not be cut mid-character.
	in := "Amélie Poulain — Édition"
	got := truncate(in, 10)
	if len([]rune(got)) != 10 {
		t.Errorf("truncate produced %d runes, want 10: %q", len([]rune(got)), got)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated text should end in an ellipsis, got %q", got)
	}
	if truncate("short", 10) != "short" {
		t.Error("text within the width must be untouched")
	}
}

func TestPadAlignsColumns(t *testing.T) {
	if got := pad("ab", 5); got != "ab   " {
		t.Errorf("pad = %q", got)
	}
	if got := padLeft("7", 4); got != "   7" {
		t.Errorf("padLeft = %q", got)
	}
	if got := pad("abcdefgh", 4); len([]rune(got)) != 4 {
		t.Errorf("pad must also truncate, got %q", got)
	}
}

func TestProgressBarShowsAStartedDownload(t *testing.T) {
	// 0.4% and 0% must not look identical, or a stalled start is invisible.
	if got := progressBar(0.004, 10); got == strings.Repeat("░", 10) {
		t.Error("a started download must show at least one filled cell")
	}
	if got := progressBar(0, 10); got != strings.Repeat("░", 10) {
		t.Errorf("zero progress should be empty, got %q", got)
	}
	if got := progressBar(1, 4); got != "████" {
		t.Errorf("complete should be full, got %q", got)
	}
	if got := progressBar(5, 4); got != "████" {
		t.Errorf("out-of-range must clamp, got %q", got)
	}
}

func TestUnavailableReasonSeparatesForbiddenFromBroken(t *testing.T) {
	// The distinction the contract draws: one sends an operator to their
	// administrator, the other to the logs.
	forbidden := unavailableReason("forbidden", "")
	broken := unavailableReason("unavailable", "connection refused")
	if forbidden == broken {
		t.Fatal("forbidden and unavailable must not read the same")
	}
	if !strings.Contains(forbidden, "may not") {
		t.Errorf("forbidden should say so plainly, got %q", forbidden)
	}
	if !strings.Contains(broken, "connection refused") {
		t.Errorf("an unavailable panel should carry the server's reason, got %q", broken)
	}
	if !strings.Contains(unavailableReason("timeout", ""), "too long") {
		t.Error("a timeout should say the server was slow, not that it is broken")
	}
}

func TestHealthAndSeverityAlwaysCarryAGlyph(t *testing.T) {
	// Colour alone excludes anyone with a colour vision deficiency and vanishes
	// through a pipe, so every state has a distinct mark too.
	seen := map[string]bool{}
	for _, h := range []api.Health{api.HealthHealthy, api.HealthDegraded, api.HealthDown, api.HealthUnknown} {
		mark := healthMark(h)
		if mark == "" {
			t.Fatalf("health %q has no glyph", h)
		}
		if seen[mark] {
			t.Errorf("health %q reuses glyph %q", h, mark)
		}
		seen[mark] = true
	}
	seen = map[string]bool{}
	for _, s := range []api.Severity{api.SeverityCritical, api.SeverityError, api.SeverityWarning, api.SeverityInfo} {
		mark := severityMark(s)
		if seen[mark] {
			t.Errorf("severity %q reuses glyph %q", s, mark)
		}
		seen[mark] = true
	}
}

func TestSectionExplainsEveryAbsence(t *testing.T) {
	// A blank space where data should be is the one thing an observability
	// client must never show.
	rendered := section("Torrents", nil, func(int) string { return "data" })
	if !strings.Contains(rendered, "Not requested") {
		t.Errorf("a nil domain must say so, got %q", rendered)
	}

	denied := section("Torrents", &api.Domain[int]{Available: false, Reason: "forbidden"},
		func(int) string { return "data" })
	if strings.Contains(denied, "data") {
		t.Error("a forbidden domain must not render its zero value as content")
	}
	if !strings.Contains(denied, "may not") {
		t.Errorf("a forbidden domain must explain itself, got %q", denied)
	}

	ok := section("Torrents", &api.Domain[int]{Available: true, Data: 42},
		func(v int) string { return "value" })
	if !strings.Contains(ok, "value") {
		t.Error("an available domain must render its data")
	}
}

func TestOverdueAllowsOneMissedPoll(t *testing.T) {
	// A poll landing a moment late is normal; flagging it would make "overdue"
	// meaningless.
	recent := time.Now().Add(-90 * time.Second).Format(time.RFC3339)
	if overdue(&recent, 60) {
		t.Error("90s against a 60s interval is late, not overdue")
	}
	stale := time.Now().Add(-10 * time.Minute).Format(time.RFC3339)
	if !overdue(&stale, 60) {
		t.Error("10 minutes against a 60s interval is overdue")
	}
	if overdue(nil, 60) {
		t.Error("a feed never polled is not 'overdue' — it has no baseline")
	}
}
