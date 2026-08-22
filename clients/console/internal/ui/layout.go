package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/api"
)

// Pane composition.
//
// The console is a dashboard, not a print-out: an operator scans it for the one
// thing that is wrong, and a single stacked column of styled text makes that a
// reading exercise. Panes give each subject a frame, a title and a fixed place
// on screen, so the eye learns where "storage" lives and goes straight there.
//
// Everything here is width-aware and ANSI-aware. Content arrives already styled,
// so padding is measured with lipgloss.Width — `len()` on a styled string counts
// escape bytes and would tear every box it touched.

// Border glyphs, drawn by hand rather than with lipgloss's Border().
//
// A titled top rail (`╭─ Storage ─────╮`) is what makes a pane read as a labelled
// instrument instead of a box with a heading floating above it, and lipgloss v1
// has no way to inject a title into a border. Composing the rails directly costs
// a few lines and buys the whole look.
const (
	cornerTL = "╭"
	cornerTR = "╮"
	cornerBL = "╰"
	cornerBR = "╯"
	edgeH    = "─"
	edgeV    = "│"
)

// minPaneWidth is the narrowest a pane may be before columns are abandoned.
//
// Below this, a two-column grid truncates every value it holds — and a number
// cut in half is worse than a number lower down the page.
const minPaneWidth = 46

// panel draws one titled pane of an exact total width, borders included.
func panel(title, body string, totalWidth int) string {
	return panelWithAccent(title, body, totalWidth, styleMuted, styleTitle)
}

// panelSeverity is the same pane, drawn in a colour that carries its state.
//
// Used where the frame itself should say something: a pane holding a critical
// alert is worth spotting before a word of it is read.
func panelSeverity(title, body string, totalWidth int, sev api.Severity) string {
	style := severityStyle(sev)
	return panelWithAccent(title, body, totalWidth, style, style)
}

func panelWithAccent(title, body string, totalWidth int, border, titleStyle lipgloss.Style) string {
	if totalWidth < 8 {
		totalWidth = 8
	}
	inner := totalWidth - 2 // the two vertical rails

	// Top rail: ╭─ Title ──────╮
	label := ""
	if title != "" {
		label = " " + truncate(title, maxInt(inner-4, 1)) + " "
	}
	fillWidth := inner - lipgloss.Width(label) - 1
	if fillWidth < 0 {
		fillWidth = 0
	}
	top := border.Render(cornerTL+edgeH) + titleStyle.Render(label) +
		border.Render(strings.Repeat(edgeH, fillWidth)+cornerTR)

	// Body: every line padded to the inner width so the right rail lines up.
	var b strings.Builder
	b.WriteString(top)
	for _, line := range strings.Split(body, "\n") {
		b.WriteString("\n")
		b.WriteString(border.Render(edgeV) + " " + fit(line, inner-2) + " " + border.Render(edgeV))
	}
	b.WriteString("\n" + border.Render(cornerBL+strings.Repeat(edgeH, inner)+cornerBR))
	return b.String()
}

// fit pads or truncates a possibly-styled line to an exact visible width.
func fit(line string, width int) string {
	if width < 0 {
		width = 0
	}
	w := lipgloss.Width(line)
	switch {
	case w == width:
		return line
	case w < width:
		return line + strings.Repeat(" ", width-w)
	default:
		// Truncating styled text safely is lipgloss's job — cutting the raw
		// string would slice an escape sequence and bleed colour down the pane.
		return lipgloss.NewStyle().MaxWidth(width).Render(line)
	}
}

// columns lays panes side by side, padding them to a common height.
//
// Equal height is what makes a grid a grid: without it the next row starts at a
// ragged edge and the alignment an operator is relying on disappears.
func columns(gap int, panes ...string) string {
	present := make([]string, 0, len(panes))
	for _, p := range panes {
		if strings.TrimSpace(p) != "" {
			present = append(present, p)
		}
	}
	if len(present) == 0 {
		return ""
	}
	if len(present) == 1 {
		return present[0]
	}

	height := 0
	for _, p := range present {
		if h := lipgloss.Height(p); h > height {
			height = h
		}
	}
	padded := make([]string, 0, len(present)*2)
	for i, p := range present {
		if i > 0 {
			padded = append(padded, strings.Repeat(" ", gap))
		}
		padded = append(padded, padHeight(p, height))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, padded...)
}

// padHeight extends a pane with blank lines of its own width.
//
// Blank lines matched to the pane's width, not empty strings: JoinHorizontal
// aligns on the widest line of each block, and a bare "" would let the next
// column slide left under the short one.
func padHeight(pane string, height int) string {
	h := lipgloss.Height(pane)
	if h >= height {
		return pane
	}
	w := lipgloss.Width(pane)
	blank := strings.Repeat(" ", w)
	return pane + strings.Repeat("\n"+blank, height-h)
}

// rows stacks blocks vertically with one blank line between them.
func rows(blocks ...string) string {
	present := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if strings.TrimSpace(b) != "" {
			present = append(present, b)
		}
	}
	return strings.Join(present, "\n")
}

// splitWidth divides the available width into n columns with gaps.
//
// Any remainder goes to the LAST column rather than being dropped, so the grid
// always reaches the right edge — a one-column gutter on a wide terminal reads
// as a rendering bug.
func splitWidth(total, n, gap int) []int {
	if n <= 1 {
		return []int{total}
	}
	usable := total - gap*(n-1)
	if usable < n*minPaneWidth {
		return nil // caller falls back to a single column
	}
	each := usable / n
	out := make([]int, n)
	for i := range out {
		out[i] = each
	}
	out[n-1] += usable - each*n
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
