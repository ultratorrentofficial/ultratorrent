package ui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/ultratorrent/utconsole/internal/api"
	"github.com/ultratorrent/utconsole/internal/realtime"
)

// StreamCapacity is how many events the console keeps.
//
// A ring buffer, and a small one on purpose. This is **not history** — the
// record of what happened is the audit log, and a client that hoarded events
// would be inviting an operator to treat a few minutes of whatever arrived
// while the console happened to be open as the authoritative account. Bounded
// also means a busy install cannot grow the console's memory without limit.
const StreamCapacity = 200

// stream is the bounded, non-authoritative event buffer.
type stream struct {
	events []api.Event
	// seen guards against a redelivery rendering twice. The contract promises a
	// stable id per occurrence precisely so a client can do this.
	seen map[string]struct{}
	// dropped counts what fell off the end, so the view can say the buffer is
	// not the whole story rather than implying it is.
	dropped int
	status  realtime.Status
	err     error
	// filter narrows by category; empty shows everything.
	filter string
}

func newStream() *stream {
	return &stream{
		events: make([]api.Event, 0, StreamCapacity),
		seen:   make(map[string]struct{}, StreamCapacity),
		status: realtime.StatusConnecting,
	}
}

// add records an event, newest first, dropping the oldest past capacity.
func (s *stream) add(raw json.RawMessage) {
	var e api.Event
	if err := json.Unmarshal(raw, &e); err != nil {
		// A frame this console cannot read is not worth killing the stream over,
		// and rendering a blank line would be worse than skipping it.
		return
	}
	if e.ID != "" {
		if _, dup := s.seen[e.ID]; dup {
			return
		}
		s.seen[e.ID] = struct{}{}
	}

	s.events = append([]api.Event{e}, s.events...)
	if len(s.events) > StreamCapacity {
		for _, gone := range s.events[StreamCapacity:] {
			delete(s.seen, gone.ID)
		}
		s.events = s.events[:StreamCapacity]
		s.dropped++
	}
}

// categories lists what is currently in the buffer, for the filter hint.
func (s *stream) categories() []string {
	set := map[string]struct{}{}
	for _, e := range s.events {
		if e.Category != "" {
			set[e.Category] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// visible applies the current filter.
func (s *stream) visible() []api.Event {
	if s.filter == "" {
		return s.events
	}
	out := make([]api.Event, 0, len(s.events))
	for _, e := range s.events {
		if e.Category == s.filter {
			out = append(out, e)
		}
	}
	return out
}

// cycleFilter steps through "all" and each category currently in the buffer.
//
// Driven by what has actually arrived rather than by a fixed list of every
// category the platform can emit: a filter offering twelve options on an
// install that only ever produces three is a worse tool.
func (s *stream) cycleFilter() {
	cats := s.categories()
	if len(cats) == 0 {
		s.filter = ""
		return
	}
	if s.filter == "" {
		s.filter = cats[0]
		return
	}
	for i, c := range cats {
		if c == s.filter {
			if i+1 < len(cats) {
				s.filter = cats[i+1]
			} else {
				s.filter = ""
			}
			return
		}
	}
	// The filtered category aged out of the buffer; fall back to showing all.
	s.filter = ""
}

// statusText describes the connection in a way that distinguishes its failures.
func (s *stream) statusText() string {
	switch s.status {
	case realtime.StatusConnected:
		return styleOK.Render("● live")
	case realtime.StatusConnecting:
		return styleMuted.Render("○ connecting")
	case realtime.StatusRefused:
		// Not the same as a dropped connection, and a different fix.
		msg := "✕ refused"
		if s.err != nil {
			msg += ": " + s.err.Error()
		}
		return styleErr.Render(msg)
	default:
		msg := "✕ disconnected"
		if s.err != nil {
			msg += ": " + s.err.Error()
		}
		return styleWarn.Render(msg)
	}
}

// viewStream renders the narrative as its own pane.
func (m Model) viewStream() string {
	s := m.stream
	w := m.contentWidth()

	title := "Event stream · " + s.statusText()
	if s.filter != "" {
		title += styleAccent.Render(" · " + s.filter)
	}

	var b strings.Builder
	/*
	 * Said plainly, every time. The buffer holds what arrived while this console
	 * was open — it does not backfill, and an operator reading it as history
	 * will draw wrong conclusions from a quiet screen. Shortened rather than
	 * dropped on a narrow terminal: the caveat matters more than its wording.
	 */
	caveat := "Live only — since this console connected. The record is the audit log."
	if w < 90 {
		caveat = "Live only — not history."
	}
	b.WriteString(styleMuted.Render(caveat))
	b.WriteString("\n")

	events := s.visible()
	if len(events) == 0 {
		if s.status == realtime.StatusConnected {
			b.WriteString(styleMuted.Render("Connected. Nothing has happened yet."))
		} else {
			b.WriteString(styleMuted.Render("Waiting for the stream…"))
		}
		return panel(title, b.String(), w)
	}

	// inner width, less the two rails and their padding
	inner := w - 4
	summaryW := inner - 9 - 1 - 1 - 1 - 13 - 1
	if summaryW < 12 {
		summaryW = 12
	}
	lines := make([]string, 0, len(events))
	for _, e := range events {
		if len(lines) >= m.streamRows() {
			break
		}
		summary := e.Summary
		if e.Actor != nil && *e.Actor != "" {
			summary += " · " + *e.Actor
		}
		lines = append(lines, strings.Join([]string{
			styleMuted.Render(pad(clockOf(e.At), 9)),
			severityStyle(e.Severity).Render(severityMark(e.Severity)),
			styleMuted.Render(pad(truncate(e.Category, 12), 13)),
			truncate(summary, summaryW),
		}, " "))
	}
	b.WriteString(strings.Join(lines, "\n"))

	if s.dropped > 0 {
		b.WriteString("\n" + styleMuted.Render(fmt.Sprintf(
			"… %d older event(s) have scrolled out of the buffer.", s.dropped)))
	}
	if cats := s.categories(); len(cats) > 1 {
		b.WriteString("\n" + styleMuted.Render(truncate("f filters: all · "+strings.Join(cats, " · "), inner)))
	}
	return panel(title, b.String(), w)
}

// streamRows is how many lines fit under the chrome.
func (m Model) streamRows() int {
	n := m.height - 14
	if n < 5 {
		return 5
	}
	return n
}

// clockOf renders just the time-of-day from an ISO timestamp.
//
// Not an age: the stream is a sequence, and "12:04:31" next to "12:04:33" shows
// the ordering and the gap at once, where "2m ago" twice does not.
func clockOf(iso string) string {
	if len(iso) >= 19 {
		return iso[11:19]
	}
	return iso
}
