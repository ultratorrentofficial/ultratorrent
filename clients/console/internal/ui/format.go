package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/api"
	"github.com/ultratorrent/utconsole/internal/i18n"
)

// Formatting rules, in one place so every panel agrees.
//
// The bias throughout is toward what an operator can read at a glance in a
// fixed-width terminal: short units, aligned columns, and no value rendered
// with more precision than the underlying measurement has.

// humanBytes renders a byte count in the largest unit that keeps it under 1024.
func humanBytes(n int64) string {
	if n < 0 {
		return i18n.T("format.negative")
	}
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 5; v /= unit {
		div *= unit
		exp++
	}
	// One decimal below 10, none above: "9.4 GB" is useful, "941.7 GB" is not.
	value := float64(n) / float64(div)
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, [...]string{"KB", "MB", "GB", "TB", "PB", "EB"}[exp])
	}
	return fmt.Sprintf("%.0f %s", value, [...]string{"KB", "MB", "GB", "TB", "PB", "EB"}[exp])
}

// humanRate renders bytes-per-second, blanking a genuine zero.
//
// A column of "0 B/s" is visual noise that hides the rows that are actually
// moving; an idle torrent shows nothing and the eye goes where it should.
func humanRate(n int64) string {
	if n <= 0 {
		return ""
	}
	return humanBytes(n) + "/s"
}

// humanDuration renders a span coarsely: an operator wants "3d" not "3d 4h 12m".
func humanDuration(d time.Duration) string {
	if d < 0 {
		return i18n.T("format.negative")
	}
	switch {
	case d < time.Minute:
		return i18n.T("format.seconds", int(d.Seconds()))
	case d < time.Hour:
		return i18n.T("format.minutes", int(d.Minutes()))
	case d < 24*time.Hour:
		return i18n.T("format.hours", int(d.Hours()), int(d.Minutes())%60)
	default:
		return i18n.T("format.days", int(d.Hours())/24, int(d.Hours())%24)
	}
}

// humanETA renders a countdown, distinguishing "never" from "unknown".
//
// Engines report a sentinel for a torrent that will not finish at its current
// rate. Rendering that as a number ("8y") is worse than saying so.
func humanETA(eta *int64) string {
	if eta == nil {
		return ""
	}
	switch v := *eta; {
	case v < 0:
		return i18n.T("format.forever")
	case v == 0:
		return ""
	case v > 365*24*3600:
		return i18n.T("format.forever")
	default:
		return humanDuration(time.Duration(v) * time.Second)
	}
}

// ago renders an ISO timestamp as an age, which is what an operator reads it as.
func ago(iso *string) string {
	if iso == nil || *iso == "" {
		return i18n.T("format.never")
	}
	t, err := time.Parse(time.RFC3339, *iso)
	if err != nil {
		return i18n.T("format.unparseable")
	}
	d := time.Since(t)
	if d < 0 {
		// Clock skew between the console's host and the server's. Reporting a
		// negative age would look like a bug in the platform rather than a
		// disagreement about the time.
		return i18n.T("format.justNow")
	}
	// A format string rather than a suffix: Spanish puts the age AFTER the
	// preposition ("hace 3m"), and a hardcoded " ago" cannot be moved.
	return i18n.T("format.ago", humanDuration(d))
}

/*
 * Width helpers measure with lipgloss.Width, never len().
 *
 * A styled string carries escape bytes that a terminal does not draw. Measuring
 * with len() counts them, so a coloured cell is padded as though it were far
 * wider than it looks — every column after it shifts left, the pane's right rail
 * lands in the middle of the text, and the box appears "displaced". Worse,
 * slicing runes can cut an escape sequence in half and bleed its colour across
 * the rest of the screen. Both were visible on real data before this changed.
 */

// truncate shortens to a visible width, with an ellipsis.
func truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	if width == 1 {
		return "…"
	}
	// MaxWidth is escape-aware: it will not slice a sequence in half.
	return lipgloss.NewStyle().MaxWidth(width-1).Render(s) + "…"
}

// pad right-pads to a visible width so columns line up, truncating when too long.
func pad(s string, width int) string {
	s = truncate(s, width)
	if n := width - lipgloss.Width(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}

// padLeft right-aligns, for numeric columns.
func padLeft(s string, width int) string {
	s = truncate(s, width)
	if n := width - lipgloss.Width(s); n > 0 {
		return strings.Repeat(" ", n) + s
	}
	return s
}

// progressBar draws a proportion in a fixed cell count.
func progressBar(fraction float64, width int) string {
	if width <= 0 {
		return ""
	}
	if fraction < 0 {
		fraction = 0
	}
	if fraction > 1 {
		fraction = 1
	}
	filled := int(fraction * float64(width))
	// A started-but-tiny download must show something, or "0%" and "0.4%" look
	// identical and an operator cannot tell a stalled start from a live one.
	if filled == 0 && fraction > 0 {
		filled = 1
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

// meterFor is a FULL-IS-BAD bar: disk usage, quota, pressure.
//
// The thresholds match the server's alert projection, so a bar that has turned
// red and an alert that has fired are saying the same thing rather than
// disagreeing by a few percent.
func meterFor(fraction float64, width int) string {
	style := styleOK
	switch {
	case fraction >= 0.97:
		style = styleErr
	case fraction >= 0.9:
		style = styleWarn
	}
	return paintMeter(fraction, width, style)
}

// progressMeter is a FULL-IS-GOOD bar: download progress, playback position.
//
// Separate from meterFor because the two have opposite senses and sharing one
// function got it exactly backwards in practice — every completed torrent
// rendered its progress bar in alarm red, because 100% tripped the
// disk-is-nearly-full threshold. A finished download is the good case.
func progressMeter(fraction float64, width int) string {
	style := styleAccent
	if fraction >= 1 {
		style = styleOK
	}
	return paintMeter(fraction, width, style)
}

// paintMeter colours only the filled run, so the bar reads as a proportion
// rather than as a block of colour.
func paintMeter(fraction float64, width int, style lipgloss.Style) string {
	bar := progressBar(fraction, width)
	filled := len([]rune(strings.ReplaceAll(bar, "░", "")))
	runes := []rune(bar)
	return style.Render(string(runes[:filled])) + styleMuted.Render(string(runes[filled:]))
}

// percent renders a fraction, or "—" when it was never measured.
func percent(p *float64) string {
	if p == nil {
		return i18n.T("format.none")
	}
	return fmt.Sprintf("%.0f%%", *p)
}

// healthMark is the one-glyph state, paired with colour by the caller.
//
// A glyph as well as a colour, deliberately: colour alone excludes anyone with
// a colour vision deficiency and disappears entirely through a pipe.
func healthMark(h api.Health) string {
	switch h {
	case api.HealthHealthy:
		return "●"
	case api.HealthDegraded:
		return "◐"
	case api.HealthDown:
		return "✕"
	default:
		return "○"
	}
}

// severityMark is the same idea for alerts.
func severityMark(s api.Severity) string {
	switch s {
	case api.SeverityCritical:
		return "✕"
	case api.SeverityError:
		return "!"
	case api.SeverityWarning:
		return "▲"
	default:
		return "·"
	}
}

// unavailableReason turns a degraded domain into a sentence worth reading.
//
// The distinction the contract draws is the whole point: "you may not see this"
// sends an operator to their administrator, "this is broken" sends them to the
// logs, and one grey box for both wastes the trip.
func unavailableReason(reason, message string) string {
	switch reason {
	case "forbidden":
		return i18n.T("unavailable.forbidden")
	case "timeout":
		return i18n.T("unavailable.timeout")
	case "disabled":
		return i18n.T("unavailable.disabled")
	default:
		if message != "" {
			// The server's own words, in whatever language it produced them —
			// a message this console cannot translate is still worth showing.
			return i18n.T("unavailable.reason", message)
		}
		return i18n.T("unavailable.unknown")
	}
}

// clock renders a timestamp as a wall-clock time an operator can compare with
// something else.
//
// `ago` answers "how long since", which is the right question for a heartbeat
// and the wrong one for "when did this run". Correlating a job with a log line,
// a support message or another system's record needs the time on the clock, so
// this shows HH:MM for today and adds the date once it is older than that —
// a date on every row would spend width on a fact that is usually the same.
func clock(iso *string) string {
	if iso == nil || *iso == "" {
		return i18n.T("format.none")
	}
	t, err := time.Parse(time.RFC3339, *iso)
	if err != nil {
		return i18n.T("format.unparseable")
	}
	local := t.Local()
	if local.YearDay() == time.Now().YearDay() && local.Year() == time.Now().Year() {
		return local.Format("15:04:05")
	}
	return local.Format("Jan 02 15:04")
}
