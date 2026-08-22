package realtime

import (
	"encoding/json"
	"strings"
	"testing"
)

// Frames captured from the protocol this console actually talks to. Writing the
// parser by hand is only defensible if every case is pinned, including the ones
// a proxy or a server upgrade can produce.

func TestDecodeOpenHandshake(t *testing.T) {
	f, err := Decode(`0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`)
	if err != nil {
		t.Fatal(err)
	}
	if f.Kind != KindOpen {
		t.Fatalf("kind = %v, want open", f.Kind)
	}
	if f.PingIntervalMs != 25000 {
		t.Errorf("pingInterval = %d", f.PingIntervalMs)
	}
}

func TestDecodeOpenWithUnreadableJSONIsStillAnOpen(t *testing.T) {
	// The interval is a nicety. Refusing to connect over it would be worse than
	// letting the server's pings drive the heartbeat.
	f, err := Decode(`0{not json`)
	if err != nil {
		t.Fatalf("an open with bad JSON must not fail the connection: %v", err)
	}
	if f.Kind != KindOpen {
		t.Errorf("kind = %v, want open", f.Kind)
	}
}

func TestDecodePingAndConnect(t *testing.T) {
	if f, _ := Decode("2"); f.Kind != KindPing {
		t.Errorf("`2` should be a ping, got %v", f.Kind)
	}
	if f, _ := Decode(`40{"sid":"xyz"}`); f.Kind != KindConnected {
		t.Errorf("`40` should be a connect ack, got %v", f.Kind)
	}
	if f, _ := Decode("1"); f.Kind != KindClose {
		t.Errorf("`1` should be a close, got %v", f.Kind)
	}
	if f, _ := Decode("41"); f.Kind != KindDisconnect {
		t.Errorf("`41` should be a namespace disconnect, got %v", f.Kind)
	}
}

func TestDecodeEvent(t *testing.T) {
	raw := `42["operations.event",{"id":"evt-1","summary":"Download complete: Some.Release","severity":"info"}]`
	f, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if f.Kind != KindEvent {
		t.Fatalf("kind = %v, want event", f.Kind)
	}
	if f.Name != "operations.event" {
		t.Errorf("name = %q", f.Name)
	}
	var payload struct {
		ID      string `json:"id"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(f.Payload, &payload); err != nil {
		t.Fatalf("payload did not decode: %v", err)
	}
	if payload.ID != "evt-1" {
		t.Errorf("payload = %+v", payload)
	}
}

func TestDecodeEventWithAnAckID(t *testing.T) {
	// The server may ask for an ack. This client never sends one, but the digits
	// must not be mistaken for corruption.
	f, err := Decode(`42123["operations.event",{"id":"evt-2"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if f.Kind != KindEvent || f.Name != "operations.event" {
		t.Fatalf("frame = %+v", f)
	}
}

func TestDecodeEventWithNoPayload(t *testing.T) {
	f, err := Decode(`42["ping-like"]`)
	if err != nil {
		t.Fatal(err)
	}
	if f.Kind != KindEvent || f.Name != "ping-like" {
		t.Fatalf("frame = %+v", f)
	}
	if f.Payload != nil {
		t.Errorf("payload should be nil, got %s", f.Payload)
	}
}

func TestDecodeConnectErrorCarriesTheReason(t *testing.T) {
	f, err := Decode(`44{"message":"Not authorized"}`)
	if err != nil {
		t.Fatal(err)
	}
	if f.Kind != KindConnectError {
		t.Fatalf("kind = %v, want connect error", f.Kind)
	}
	// The operator has to be told it was the identity, not the network.
	if f.Message != "Not authorized" {
		t.Errorf("message = %q", f.Message)
	}
}

func TestDecodeConnectErrorWithoutAMessageStillExplains(t *testing.T) {
	f, _ := Decode(`44`)
	if f.Message == "" {
		t.Error("a connect error must always say something")
	}
}

func TestUnknownFramesAreIgnoredNotFatal(t *testing.T) {
	// A server upgrade that adds a packet type must not knock the console off.
	for _, raw := range []string{"3", "6", "9", "43[]", "45", "4x"} {
		f, err := Decode(raw)
		if err != nil {
			t.Errorf("Decode(%q) errored: %v", raw, err)
		}
		if f.Kind == KindEvent {
			t.Errorf("Decode(%q) should not have produced an event", raw)
		}
	}
}

func TestMalformedFramesAreReportedNotGuessed(t *testing.T) {
	for _, raw := range []string{"", "4", `42{"not":"an array"}`, `42[]`, `42[123]`} {
		if _, err := Decode(raw); err == nil {
			t.Errorf("Decode(%q) should have failed", raw)
		}
	}
}

func TestConnectFrameCarriesTheTokenInThePayload(t *testing.T) {
	frame := ConnectFrame("jwt-value")
	if !strings.HasPrefix(frame, "40") {
		t.Fatalf("frame = %q, want a CONNECT", frame)
	}
	var payload map[string]string
	if err := json.Unmarshal([]byte(frame[2:]), &payload); err != nil {
		t.Fatalf("connect payload is not JSON: %v", err)
	}
	if payload["token"] != "jwt-value" {
		t.Errorf("payload = %v", payload)
	}
}

func TestPongIsTheOnlyThingWeSendAfterHandshake(t *testing.T) {
	// A listener has nothing to say. If this ever becomes something else, the
	// "read-only on the realtime path too" claim needs revisiting.
	if PongFrame() != "3" {
		t.Errorf("pong = %q, want \"3\"", PongFrame())
	}
}

func TestWSURLKeepsTheTrailingSlash(t *testing.T) {
	// nginx proxies `location /ws/`. Without the trailing slash the request
	// falls through to the SPA's index.html and the upgrade fails in a way that
	// looks like the server is down.
	cases := map[string]string{
		"http://host:8888":   "ws://host:8888/ws/?EIO=4&transport=websocket",
		"https://host":       "wss://host/ws/?EIO=4&transport=websocket",
		"https://host/":      "wss://host/ws/?EIO=4&transport=websocket",
		"https://host/app":   "wss://host/app/ws/?EIO=4&transport=websocket",
	}
	for in, want := range cases {
		c := New(in, "operations.event", nil)
		got, err := c.wsURL()
		if err != nil {
			t.Fatalf("wsURL(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("wsURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWSURLRejectsANonHTTPScheme(t *testing.T) {
	c := New("ftp://host", "operations.event", nil)
	if _, err := c.wsURL(); err == nil {
		t.Error("expected an error for a non-http scheme")
	}
}

func TestWSURLCarriesNoToken(t *testing.T) {
	// nginx logs request URLs. A token in the query string would be written to
	// disk in plain text on every connect, on the host being monitored.
	c := New("https://host", "operations.event", nil)
	got, _ := c.wsURL()
	if strings.Contains(strings.ToLower(got), "token") {
		t.Errorf("the websocket URL must not carry a credential: %q", got)
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	c := New("https://host", "operations.event", nil)
	c.MaxBackoff = 30 * 1e9 // 30s

	first := c.backoff(1)
	second := c.backoff(2)
	if second <= first {
		t.Errorf("backoff should grow: %v then %v", first, second)
	}
	if got := c.backoff(50); got != c.MaxBackoff {
		t.Errorf("backoff(50) = %v, want the cap %v", got, c.MaxBackoff)
	}
	// A zero or negative attempt must not produce a zero delay and spin.
	if c.backoff(0) <= 0 {
		t.Error("backoff must never be zero")
	}
}
