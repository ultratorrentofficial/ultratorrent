package ui

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ultratorrent/utconsole/internal/realtime"
)

func event(id, category, summary string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"id": id, "category": category, "summary": summary,
		"at": "2026-08-22T12:00:00.000Z", "severity": "info", "eventKey": "test.event",
	})
	return raw
}

func TestStreamKeepsNewestFirst(t *testing.T) {
	s := newStream()
	s.add(event("a", "torrent", "first"))
	s.add(event("b", "torrent", "second"))

	if len(s.events) != 2 {
		t.Fatalf("want 2 events, got %d", len(s.events))
	}
	// A narrative reads top-down from what just happened.
	if s.events[0].Summary != "second" {
		t.Errorf("newest should be first, got %q", s.events[0].Summary)
	}
}

func TestStreamDedupesARedelivery(t *testing.T) {
	// The contract promises a stable id per occurrence precisely so a client can
	// do this; a reconnect that replays must not double every line.
	s := newStream()
	s.add(event("same", "torrent", "once"))
	s.add(event("same", "torrent", "once"))

	if len(s.events) != 1 {
		t.Errorf("a redelivered event must not render twice, got %d", len(s.events))
	}
}

func TestStreamIsBoundedAndSaysSo(t *testing.T) {
	s := newStream()
	for i := 0; i < StreamCapacity+25; i++ {
		s.add(event(fmt.Sprintf("e%d", i), "job", "line"))
	}
	if len(s.events) != StreamCapacity {
		t.Errorf("buffer = %d, want the cap %d", len(s.events), StreamCapacity)
	}
	// Silently dropping would let the view imply it holds everything.
	if s.dropped == 0 {
		t.Error("the buffer must record that it dropped events")
	}
	// The dedup set must shrink with the buffer, or it grows without bound on a
	// long-running console — the leak a naive ring buffer produces.
	if len(s.seen) > StreamCapacity {
		t.Errorf("seen set = %d, should not exceed the capacity", len(s.seen))
	}
}

func TestStreamIgnoresAnUnreadablePayload(t *testing.T) {
	s := newStream()
	s.add(json.RawMessage(`{"id":`))
	s.add(json.RawMessage(`not json at all`))
	if len(s.events) != 0 {
		t.Errorf("undecodable frames must be skipped, got %d events", len(s.events))
	}
	// And must not have killed the buffer for well-formed ones that follow.
	s.add(event("ok", "job", "fine"))
	if len(s.events) != 1 {
		t.Error("a bad frame must not poison the stream")
	}
}

func TestStreamAcceptsAnEventWithNoID(t *testing.T) {
	// Dedup is best-effort. An event without an id is still worth showing.
	s := newStream()
	s.add(json.RawMessage(`{"summary":"anonymous","category":"job","at":"2026-08-22T12:00:00.000Z"}`))
	if len(s.events) != 1 {
		t.Fatalf("want the event kept, got %d", len(s.events))
	}
}

func TestFilterCyclesThroughWhatArrived(t *testing.T) {
	s := newStream()
	s.add(event("1", "torrent", "a"))
	s.add(event("2", "job", "b"))

	if len(s.visible()) != 2 {
		t.Fatal("no filter should show everything")
	}
	// Categories are sorted, so the cycle is deterministic: job, torrent, all.
	s.cycleFilter()
	if s.filter != "job" {
		t.Fatalf("first filter = %q, want job", s.filter)
	}
	if got := s.visible(); len(got) != 1 || got[0].Category != "job" {
		t.Errorf("filtered view = %+v", got)
	}
	s.cycleFilter()
	if s.filter != "torrent" {
		t.Fatalf("second filter = %q, want torrent", s.filter)
	}
	s.cycleFilter()
	if s.filter != "" {
		t.Errorf("the cycle must return to showing everything, got %q", s.filter)
	}
}

func TestFilterResetsWhenItsCategoryAgesOut(t *testing.T) {
	s := newStream()
	s.add(event("1", "torrent", "a"))
	s.filter = "vanished"
	s.cycleFilter()
	if s.filter != "" {
		t.Errorf("a filter with no matching category should fall back to all, got %q", s.filter)
	}
}

func TestStatusTextSeparatesRefusedFromDisconnected(t *testing.T) {
	// "The server will not accept you" and "the network dropped" are different
	// problems with different fixes.
	s := newStream()
	s.status = realtime.StatusRefused
	s.err = fmt.Errorf("Not authorized")
	refused := s.statusText()

	s.status = realtime.StatusDisconnected
	s.err = fmt.Errorf("connection reset")
	dropped := s.statusText()

	if refused == dropped {
		t.Fatal("refused and disconnected must not read the same")
	}
	if !strings.Contains(refused, "refused") || !strings.Contains(refused, "Not authorized") {
		t.Errorf("refused status should carry the reason, got %q", refused)
	}
	if !strings.Contains(dropped, "disconnected") {
		t.Errorf("dropped status = %q", dropped)
	}
}

func TestClockOfRendersTimeOfDay(t *testing.T) {
	// A sequence, not an age: two lines a second apart must be visibly ordered.
	if got := clockOf("2026-08-22T12:04:31.000Z"); got != "12:04:31" {
		t.Errorf("clockOf = %q", got)
	}
	// Never panic on something short or unexpected.
	if got := clockOf("nope"); got != "nope" {
		t.Errorf("clockOf(short) = %q", got)
	}
}
