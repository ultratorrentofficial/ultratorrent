package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A stand-in for the gateway, speaking the same frames it does. The parser tests
// cover shapes; these cover the loop — that the handshake happens in the right
// order, that a ping is answered, and that a refused identity is reported as
// something other than a network problem.

type fakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	received []string
}

func newFakeServer(t *testing.T, behave func(ctx context.Context, c *websocket.Conn, record func(string))) *fakeServer {
	t.Helper()
	fs := &fakeServer{}
	fs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/ws/") {
			// Mirrors nginx: anything not under /ws/ is not the gateway.
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		behave(r.Context(), c, func(s string) {
			fs.mu.Lock()
			fs.received = append(fs.received, s)
			fs.mu.Unlock()
		})
	}))
	t.Cleanup(fs.Close)
	return fs
}

func (fs *fakeServer) sent() []string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return append([]string(nil), fs.received...)
}

func write(ctx context.Context, c *websocket.Conn, s string) error {
	return c.Write(ctx, websocket.MessageText, []byte(s))
}

func readOne(ctx context.Context, c *websocket.Conn, record func(string)) error {
	_, data, err := c.Read(ctx)
	if err != nil {
		return err
	}
	record(string(data))
	return nil
}

func staticToken(tok string) TokenSource {
	return func(context.Context) (string, error) { return tok, nil }
}

func TestSessionHandshakesThenStreamsEvents(t *testing.T) {
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		_ = write(ctx, c, `0{"sid":"s1","pingInterval":25000}`)
		_ = readOne(ctx, c, record) // the CONNECT with the token
		_ = write(ctx, c, `40{"sid":"s1"}`)
		_ = write(ctx, c, `42["operations.event",{"id":"evt-1","summary":"Download complete"}]`)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", staticToken("jwt-1"))
	updates := make(chan Update, 16)
	go client.Run(ctx, updates)

	var connected bool
	for {
		select {
		case u := <-updates:
			if u.Status == StatusConnected && u.Event == nil {
				connected = true
			}
			if u.Event != nil {
				if !connected {
					t.Error("an event arrived before the connect ack")
				}
				var payload struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(u.Event, &payload); err != nil {
					t.Fatalf("event payload: %v", err)
				}
				if payload.ID != "evt-1" {
					t.Errorf("payload id = %q", payload.ID)
				}
				// The token must have gone in the CONNECT body, not the URL.
				sent := srv.sent()
				if len(sent) == 0 || !strings.Contains(sent[0], "jwt-1") {
					t.Errorf("handshake did not carry the token: %v", sent)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("timed out before receiving an event")
		}
	}
}

func TestSessionAnswersPings(t *testing.T) {
	// Engine.IO closes a socket that stops ponging. An unattended console must
	// survive overnight, so this is what keeps it alive.
	done := make(chan struct{})
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		_ = write(ctx, c, `0{"sid":"s1","pingInterval":50}`)
		_ = readOne(ctx, c, record) // CONNECT
		_ = write(ctx, c, `40{"sid":"s1"}`)
		_ = write(ctx, c, "2") // ping
		_ = readOne(ctx, c, record)
		close(done)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", staticToken("jwt"))
	updates := make(chan Update, 16)
	go client.Run(ctx, updates)
	go func() {
		for range updates {
		}
	}()

	select {
	case <-done:
		sent := srv.sent()
		if len(sent) < 2 || sent[1] != "3" {
			t.Errorf("expected a pong, server saw %v", sent)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for a pong")
	}
}

func TestRefusedIdentityIsReportedDistinctly(t *testing.T) {
	// "The server will not accept you" and "the network is down" send an
	// operator to two different places.
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		_ = write(ctx, c, `0{"sid":"s1"}`)
		_ = readOne(ctx, c, record)
		_ = write(ctx, c, `44{"message":"Not authorized"}`)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", staticToken("bad"))
	client.MaxBackoff = 50 * time.Millisecond
	updates := make(chan Update, 16)
	go client.Run(ctx, updates)

	for {
		select {
		case u := <-updates:
			if u.Status == StatusRefused {
				if u.Err == nil || !strings.Contains(u.Err.Error(), "Not authorized") {
					t.Errorf("the server's reason should reach the operator, got %v", u.Err)
				}
				return
			}
			if u.Status == StatusDisconnected {
				t.Fatalf("a refused identity must not read as a dropped connection: %v", u.Err)
			}
		case <-ctx.Done():
			t.Fatal("timed out")
		}
	}
}

func TestReconnectsAfterTheServerHangsUp(t *testing.T) {
	var attempts int
	var mu sync.Mutex
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		mu.Lock()
		attempts++
		n := attempts
		mu.Unlock()

		_ = write(ctx, c, `0{"sid":"s1"}`)
		_ = readOne(ctx, c, record)
		_ = write(ctx, c, `40{"sid":"s1"}`)
		if n == 1 {
			// Drop the first connection; the console should come back.
			_ = c.Close(websocket.StatusNormalClosure, "bye")
			return
		}
		_ = write(ctx, c, `42["operations.event",{"id":"after-reconnect"}]`)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", staticToken("jwt"))
	client.MaxBackoff = 50 * time.Millisecond
	updates := make(chan Update, 32)
	go client.Run(ctx, updates)

	for {
		select {
		case u := <-updates:
			if u.Event != nil && strings.Contains(string(u.Event), "after-reconnect") {
				mu.Lock()
				defer mu.Unlock()
				if attempts < 2 {
					t.Errorf("expected a reconnect, saw %d attempts", attempts)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("the console did not reconnect")
		}
	}
}

func TestOtherChannelsAreNotSurfaced(t *testing.T) {
	// The gateway carries jobs.*, torrents:update and more on the same socket.
	// The console subscribes to one channel and must ignore the rest rather
	// than render frames it has no shape for.
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		_ = write(ctx, c, `0{"sid":"s1"}`)
		_ = readOne(ctx, c, record)
		_ = write(ctx, c, `40{"sid":"s1"}`)
		_ = write(ctx, c, `42["torrents:update",{"engineId":"e1"}]`)
		_ = write(ctx, c, `42["jobs.failed",{"jobId":"j1"}]`)
		_ = write(ctx, c, `42["operations.event",{"id":"mine"}]`)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", staticToken("jwt"))
	updates := make(chan Update, 32)
	go client.Run(ctx, updates)

	for {
		select {
		case u := <-updates:
			if u.Event == nil {
				continue
			}
			if !strings.Contains(string(u.Event), "mine") {
				t.Fatalf("a foreign channel reached the console: %s", u.Event)
			}
			return
		case <-ctx.Done():
			t.Fatal("timed out")
		}
	}
}

func TestATokenThatCannotBeObtainedIsRefusedNotRetriedHot(t *testing.T) {
	srv := newFakeServer(t, func(ctx context.Context, c *websocket.Conn, record func(string)) {
		t.Error("the client must not dial without a token")
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	client := New(srv.URL, "operations.event", func(context.Context) (string, error) {
		return "", context.DeadlineExceeded
	})
	client.MaxBackoff = 50 * time.Millisecond
	updates := make(chan Update, 16)
	go client.Run(ctx, updates)

	for {
		select {
		case u := <-updates:
			if u.Status == StatusRefused {
				return
			}
		case <-ctx.Done():
			t.Fatal("expected a refused status")
		}
	}
}
