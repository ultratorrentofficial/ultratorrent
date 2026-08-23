package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/ultratorrent/utconsole/internal/i18n"
)

// Status is what the console shows about the stream itself.
//
// Reported rather than hidden: a narrative that has quietly stopped arriving
// looks exactly like a quiet system, and those are opposite facts.
type Status string

const (
	StatusConnecting   Status = "connecting"
	StatusConnected    Status = "connected"
	StatusDisconnected Status = "disconnected"
	// StatusRefused means the server accepted the socket and rejected the
	// identity — a different problem from a network that is down, and one no
	// amount of reconnecting will fix.
	StatusRefused Status = "refused"
)

// Update is one thing that happened on the stream.
type Update struct {
	Status Status
	// Event is set when Status is StatusConnected and a payload arrived.
	Event json.RawMessage
	// Err explains a disconnect, for the status line.
	Err error
}

// TokenSource hands out a currently-valid access token.
//
// A function rather than a string because a reconnect may happen an hour into a
// session, by which point the token the console started with is long expired.
// Asking at dial time is what makes an unattended console survive overnight.
type TokenSource func(ctx context.Context) (string, error)

// Client listens to one Socket.IO channel.
//
// It never sends an application event. After the handshake the only frame it
// writes is a pong, which is a protocol obligation rather than a message — so
// "read-only" holds on the realtime path exactly as it does over REST.
type Client struct {
	baseURL string
	channel string
	token   TokenSource

	// MaxBackoff caps the wait between attempts.
	MaxBackoff time.Duration
	// dialer is swapped in tests.
	dialer func(ctx context.Context, u string, h http.Header) (*websocket.Conn, error)
}

// New builds a listener for a server root and a channel name.
func New(baseURL, channel string, token TokenSource) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		channel:    channel,
		token:      token,
		MaxBackoff: 30 * time.Second,
	}
}

// Run streams updates until ctx is cancelled.
//
// It reconnects on its own, with backoff, and reports each transition on the
// channel. It returns only when the context ends: a console whose stream died
// at 3am should be streaming again at 3:01, not showing a stale screen with no
// explanation.
func (c *Client) Run(ctx context.Context, out chan<- Update) {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		send(ctx, out, Update{Status: StatusConnecting})

		err := c.session(ctx, out)
		if ctx.Err() != nil {
			return
		}

		status := StatusDisconnected
		var refused *refusedError
		if errors.As(err, &refused) {
			// An identity the server will not accept. Still retried, because the
			// token may simply have expired and the next dial mints a new one —
			// but reported differently, so an operator is not left reading
			// "disconnected" while the real problem is a revoked account.
			status = StatusRefused
		}
		send(ctx, out, Update{Status: status, Err: err})

		attempt++
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.backoff(attempt)):
		}
	}
}

// backoff grows exponentially and is capped.
//
// No jitter, deliberately: jitter exists to stop a thundering herd, and the
// herd here is one operator's console. A predictable delay is easier to reason
// about when watching a flapping connection.
func (c *Client) backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := time.Second * time.Duration(math.Pow(2, math.Min(float64(attempt-1), 6)))
	if d > c.MaxBackoff {
		return c.MaxBackoff
	}
	return d
}

type refusedError struct{ msg string }

func (e *refusedError) Error() string { return e.msg }

// session runs one connection to completion.
func (c *Client) session(ctx context.Context, out chan<- Update) error {
	token, err := c.token(ctx)
	if err != nil {
		return &refusedError{msg: "could not obtain an access token: " + err.Error()}
	}

	endpoint, err := c.wsURL()
	if err != nil {
		return err
	}

	dial := c.dialer
	if dial == nil {
		dial = func(ctx context.Context, u string, h http.Header) (*websocket.Conn, error) {
			conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
			return conn, err
		}
	}

	conn, err := dial(ctx, endpoint, nil)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	// The snapshot caps every list; the stream needs its own ceiling so a
	// hostile or broken server cannot make the console allocate without bound.
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()

	handshaken := false
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			// Engine.IO uses binary frames for binary attachments, which this
			// client never subscribes to.
			continue
		}

		frame, err := Decode(string(data))
		if err != nil {
			// One unreadable frame is not a reason to drop a working stream.
			continue
		}

		switch frame.Kind {
		case KindOpen:
			if err := conn.Write(ctx, websocket.MessageText, []byte(ConnectFrame(token))); err != nil {
				return err
			}
		case KindPing:
			if err := conn.Write(ctx, websocket.MessageText, []byte(PongFrame())); err != nil {
				return err
			}
		case KindConnected:
			handshaken = true
			send(ctx, out, Update{Status: StatusConnected})
		case KindConnectError:
			return &refusedError{msg: frame.Message}
		case KindDisconnect, KindClose:
			if !handshaken {
				return &refusedError{msg: i18n.T("realtime.handshakeClosed")}
			}
			return errors.New(i18n.T("realtime.closed"))
		case KindEvent:
			if frame.Name == c.channel {
				send(ctx, out, Update{Status: StatusConnected, Event: frame.Payload})
			}
		}
	}
}

// wsURL builds the Engine.IO endpoint from the application root.
//
// The gateway is mounted at /ws (not socket.io's default /socket.io), and the
// trailing slash matters: nginx proxies `location /ws/`, so a request to `/ws`
// without it does not match and comes back as the SPA's index.html — which
// fails as a websocket upgrade in a way that looks like the server is down.
func (c *Client) wsURL() (string, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return "", fmt.Errorf("%s: %w", i18n.T("realtime.badServerURL"), err)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", errors.New(i18n.T("realtime.badScheme", u.Scheme))
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/"
	u.RawQuery = url.Values{
		"EIO":       {"4"},
		"transport": {"websocket"},
	}.Encode()
	return u.String(), nil
}

// send delivers without blocking a cancelled console.
func send(ctx context.Context, out chan<- Update, u Update) {
	select {
	case out <- u:
	case <-ctx.Done():
	}
}
