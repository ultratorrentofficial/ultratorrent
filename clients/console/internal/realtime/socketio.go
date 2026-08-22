// Package realtime speaks just enough Socket.IO to listen.
//
// The gateway is Socket.IO v4 over Engine.IO v4, and this console needs to
// RECEIVE events on exactly one channel. That is a small enough subset —
// framing, a handshake, a heartbeat — to implement and test directly, and doing
// so avoids taking a dependency on a third-party Socket.IO client whose
// server-oriented surface is far larger than anything used here.
//
// The parsing below is deliberately separate from the connection: it is a pure
// function of a text frame, so every protocol case can be tested without a
// server, including the malformed ones a proxy might produce.
package realtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Engine.IO packet types — the first character of a frame.
const (
	eioOpen    = '0'
	eioClose   = '1'
	eioPing    = '2'
	eioPong    = '3'
	eioMessage = '4'
)

// Socket.IO packet types — the character after an Engine.IO message.
const (
	sioConnect      = '0'
	sioDisconnect   = '1'
	sioEvent        = '2'
	sioConnectError = '4'
)

// Kind is what a decoded frame turned out to be.
type Kind int

const (
	// KindIgnorable is a frame this client has no use for. Not an error: the
	// protocol carries acks and binary types a listener never needs, and
	// treating them as failures would drop a healthy connection.
	KindIgnorable Kind = iota
	KindOpen
	KindPing
	KindConnected
	KindConnectError
	KindDisconnect
	KindEvent
	KindClose
)

// Frame is a decoded protocol frame.
type Frame struct {
	Kind Kind
	// Name is the event name, for KindEvent.
	Name string
	// Payload is the raw event body, for KindEvent.
	Payload json.RawMessage
	// Message explains a KindConnectError.
	Message string
	// PingIntervalMs comes from the open handshake, for KindOpen.
	PingIntervalMs int
}

// ErrMalformed marks a frame this client could not read at all.
var ErrMalformed = errors.New("malformed socket.io frame")

// Decode turns one text frame into a Frame.
//
// Unknown-but-well-formed frames decode to KindIgnorable rather than an error.
// A listener that dropped its connection every time the server sent something
// it did not recognise would be brittle against a server upgrade that adds a
// packet type — and the console must keep working across a version bump it
// cannot control.
func Decode(raw string) (Frame, error) {
	if raw == "" {
		return Frame{}, fmt.Errorf("%w: empty", ErrMalformed)
	}

	switch raw[0] {
	case eioPing:
		return Frame{Kind: KindPing}, nil
	case eioClose:
		return Frame{Kind: KindClose}, nil
	case eioPong:
		return Frame{Kind: KindIgnorable}, nil
	case eioOpen:
		var open struct {
			SID          string `json:"sid"`
			PingInterval int    `json:"pingInterval"`
		}
		// A handshake whose JSON will not parse is still an open: the interval
		// is a nicety, and refusing to connect over it would be worse than
		// falling back to the server's pings driving the heartbeat.
		_ = json.Unmarshal([]byte(raw[1:]), &open)
		return Frame{Kind: KindOpen, PingIntervalMs: open.PingInterval}, nil
	case eioMessage:
		return decodeMessage(raw[1:])
	default:
		return Frame{Kind: KindIgnorable}, nil
	}
}

func decodeMessage(body string) (Frame, error) {
	if body == "" {
		return Frame{}, fmt.Errorf("%w: empty message", ErrMalformed)
	}
	switch body[0] {
	case sioConnect:
		return Frame{Kind: KindConnected}, nil
	case sioDisconnect:
		return Frame{Kind: KindDisconnect}, nil
	case sioConnectError:
		return Frame{Kind: KindConnectError, Message: connectErrorMessage(body[1:])}, nil
	case sioEvent:
		return decodeEvent(body[1:])
	default:
		return Frame{Kind: KindIgnorable}, nil
	}
}

// decodeEvent reads `["name", payload]`.
//
// An ack id may precede the array (`42123["name",…]`); this client never sends
// an ack, but the server is free to ask for one, so the digits are skipped
// rather than treated as corruption.
func decodeEvent(body string) (Frame, error) {
	if i := strings.IndexByte(body, '['); i > 0 {
		body = body[i:]
	}
	var parts []json.RawMessage
	if err := json.Unmarshal([]byte(body), &parts); err != nil {
		return Frame{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if len(parts) == 0 {
		return Frame{}, fmt.Errorf("%w: event with no name", ErrMalformed)
	}
	var name string
	if err := json.Unmarshal(parts[0], &name); err != nil {
		return Frame{}, fmt.Errorf("%w: event name is not a string", ErrMalformed)
	}
	f := Frame{Kind: KindEvent, Name: name}
	if len(parts) > 1 {
		f.Payload = parts[1]
	}
	return f, nil
}

// connectErrorMessage pulls the human-readable half out of a CONNECT_ERROR.
func connectErrorMessage(body string) string {
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err == nil && payload.Message != "" {
		return payload.Message
	}
	if body == "" {
		return "the server refused the connection"
	}
	return body
}

// ConnectFrame is the handshake that authenticates the socket.
//
// The token travels in the CONNECT payload rather than the query string, which
// the gateway also accepts. The difference matters in deployment: the console
// reaches the API through nginx, and nginx writes request URLs to its access
// log — so a query-string token would be written to disk on every connect, in
// plain text, on the very host being monitored. A websocket message body is not
// logged.
func ConnectFrame(token string) string {
	payload, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		// A JSON-marshal failure on a map of strings is not reachable; connect
		// unauthenticated rather than panic, and let the server reject it.
		return "40"
	}
	return "40" + string(payload)
}

// PongFrame answers a server ping. It is the ONLY frame this client sends after
// the handshake — a listener has nothing to say.
func PongFrame() string { return string(rune(eioPong)) }
