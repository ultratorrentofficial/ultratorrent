package ui

import (
	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/api"
)

// The palette.
//
// Chosen from the ANSI 16 rather than truecolor: this runs over SSH into
// whatever terminal an operator happens to have, and a theme that assumes
// 24-bit colour renders as mud on a basic one. Lipgloss degrades automatically,
// but starting from colours that exist everywhere means the degradation is
// never surprising.
//
// Severity is always carried by a glyph as well as a colour — see healthMark.
// Colour is an accelerator here, never the only channel.
var (
	colFg      = lipgloss.AdaptiveColor{Light: "236", Dark: "252"}
	colMuted   = lipgloss.AdaptiveColor{Light: "244", Dark: "244"}
	colAccent  = lipgloss.AdaptiveColor{Light: "27", Dark: "39"}
	colOK      = lipgloss.AdaptiveColor{Light: "28", Dark: "42"}
	colWarn    = lipgloss.AdaptiveColor{Light: "130", Dark: "214"}
	colErr     = lipgloss.AdaptiveColor{Light: "160", Dark: "203"}
	colCrit    = lipgloss.AdaptiveColor{Light: "89", Dark: "199"}
	colSurface = lipgloss.AdaptiveColor{Light: "254", Dark: "236"}
)

var (
	styleBase   = lipgloss.NewStyle().Foreground(colFg)
	styleMuted  = lipgloss.NewStyle().Foreground(colMuted)
	styleAccent = lipgloss.NewStyle().Foreground(colAccent)
	styleOK     = lipgloss.NewStyle().Foreground(colOK)
	styleWarn   = lipgloss.NewStyle().Foreground(colWarn)
	styleErr    = lipgloss.NewStyle().Foreground(colErr)
	styleCrit   = lipgloss.NewStyle().Foreground(colCrit).Bold(true)

	styleTitle = lipgloss.NewStyle().Foreground(colFg).Bold(true)
	styleKey   = lipgloss.NewStyle().Foreground(colMuted)

	// The top rail. A filled bar rather than bordered text: it is chrome, and
	// chrome that looks like an instrument competes with the instruments.
	styleHeaderBar = lipgloss.NewStyle().Background(colSurface)

	styleHeaderName = lipgloss.NewStyle().
			Foreground(colAccent).
			Background(colSurface).
			Bold(true)

	styleHeaderMeta = lipgloss.NewStyle().
			Foreground(colMuted).
			Background(colSurface)

	// The active tab is a filled segment, not underlined text: on a rail of
	// nine it has to be findable at a glance, and an underline is easy to miss.
	styleTabActive = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "231", Dark: "233"}).
			Background(colAccent).
			Bold(true)

	styleTabIdle = lipgloss.NewStyle().Foreground(colMuted)

	// A tab the account cannot read. Shown rather than hidden, so an operator
	// can see that a view exists and ask for access, instead of wondering
	// whether the console is broken or the feature is missing.
	styleTabDenied = lipgloss.NewStyle().Foreground(colMuted).Faint(true).Strikethrough(true)

	styleStatusBar = lipgloss.NewStyle().Foreground(colMuted).Padding(0, 1)

	styleColHead = lipgloss.NewStyle().Foreground(colMuted).Bold(true)

	stylePanel = lipgloss.NewStyle().Padding(0, 1)
)

// healthStyle pairs a health with its colour.
func healthStyle(h api.Health) lipgloss.Style {
	switch h {
	case api.HealthHealthy:
		return styleOK
	case api.HealthDegraded:
		return styleWarn
	case api.HealthDown:
		return styleErr
	default:
		return styleMuted
	}
}

// severityStyle pairs an alert severity with its colour.
func severityStyle(s api.Severity) lipgloss.Style {
	switch s {
	case api.SeverityCritical:
		return styleCrit
	case api.SeverityError:
		return styleErr
	case api.SeverityWarning:
		return styleWarn
	default:
		return styleMuted
	}
}

// levelStyle colours an activity line by its recorded level.
func levelStyle(level string) lipgloss.Style {
	switch level {
	case "error":
		return styleErr
	case "warning":
		return styleWarn
	case "success":
		return styleOK
	default:
		return styleBase
	}
}

// torrentStateStyle colours a torrent's state word.
func torrentStateStyle(state string, stalled bool) lipgloss.Style {
	if stalled {
		return styleWarn
	}
	switch state {
	case "error":
		return styleErr
	case "downloading":
		return styleAccent
	case "seeding":
		return styleOK
	case "paused", "stopped":
		return styleMuted
	default:
		return styleBase
	}
}
