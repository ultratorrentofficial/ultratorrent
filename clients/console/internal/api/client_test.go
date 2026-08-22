package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The client's job is small and its failure modes are specific: it must refresh
// before a 401 rather than after, it must never sit in a refresh loop when an
// account is genuinely revoked, and it must refuse a contract it cannot read.

func TestLoginStoresAndRotatesTheRefreshToken(t *testing.T) {
	var rotated []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "access-1", "refreshToken": "refresh-1", "expiresIn": 900,
			})
		case "/api/auth/refresh":
			json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "access-2", "refreshToken": "refresh-2", "expiresIn": 900,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.OnRefresh(func(tok string) { rotated = append(rotated, tok) })

	if err := c.Login(context.Background(), "u", "p", ""); err != nil {
		t.Fatalf("login: %v", err)
	}
	// The callback must fire on login too: that first token is the one the
	// caller has to persist, and it is already the only copy.
	if len(rotated) != 1 || rotated[0] != "refresh-1" {
		t.Fatalf("expected the login token to be handed over, got %v", rotated)
	}
}

func TestAccessTokenIsRefreshedBeforeItExpires(t *testing.T) {
	var refreshes int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/refresh":
			atomic.AddInt32(&refreshes, 1)
			json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "fresh", "refreshToken": "next", "expiresIn": 900,
			})
		case "/api/operations/snapshot":
			if r.Header.Get("Authorization") != "Bearer fresh" {
				t.Errorf("snapshot sent %q", r.Header.Get("Authorization"))
			}
			json.NewEncoder(w).Encode(map[string]any{"contractVersion": "1.1.0"})
		}
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")

	// No access token at all: the first call must refresh rather than fire a
	// request it knows will 401.
	if _, err := c.Snapshot(context.Background(), nil, 0); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if got := atomic.LoadInt32(&refreshes); got != 1 {
		t.Fatalf("expected exactly one refresh, got %d", got)
	}

	// The second call reuses the still-valid token.
	if _, err := c.Snapshot(context.Background(), nil, 0); err != nil {
		t.Fatalf("second snapshot: %v", err)
	}
	if got := atomic.LoadInt32(&refreshes); got != 1 {
		t.Fatalf("a valid access token must be reused, saw %d refreshes", got)
	}
}

func TestRevokedSessionFailsOnceRatherThanLooping(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("revoked")

	_, err := c.Snapshot(context.Background(), nil, 0)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
	// One refresh attempt, not a retry storm against a server that has already
	// said no.
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("expected a single attempt, got %d", got)
	}
}

func TestNoStoredSessionIsUnauthorizedWithoutACall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a client with no token must not call the server at all")
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	if _, err := c.Snapshot(context.Background(), nil, 0); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}

func TestForbiddenIsDistinctFromUnauthorized(t *testing.T) {
	// 401 means "sign in"; 403 means "this account may not use the console".
	// Collapsing them sends someone to re-enter a password that was fine.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	if _, err := c.Capabilities(context.Background()); !errors.Is(err, ErrForbidden) {
		t.Fatalf("want ErrForbidden, got %v", err)
	}
}

func TestIncompatibleContractMajorIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"contractVersion": "9.0.0",
			"permittedDomains": []string{"system"},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	caps, err := c.Capabilities(context.Background())
	if !errors.Is(err, ErrIncompatible) {
		t.Fatalf("want ErrIncompatible, got %v", err)
	}
	// Returned anyway, so the message can name both versions instead of just
	// refusing.
	if caps == nil || caps.ContractVersion != "9.0.0" {
		t.Error("capabilities should still be returned so the error can be specific")
	}
	if !strings.Contains(err.Error(), "9.0.0") {
		t.Errorf("the error should name the server's version, got %q", err)
	}
}

func TestNewerMinorIsAccepted(t *testing.T) {
	// Same major, newer minor: compatible, with fields this build ignores.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"contractVersion": "1.99.0"})
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	if _, err := c.Capabilities(context.Background()); err != nil {
		t.Fatalf("a newer minor must be accepted, got %v", err)
	}
}

func TestSnapshotRequestsOnlyTheDomainsAsked(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		gotQuery = r.URL.RawQuery
		json.NewEncoder(w).Encode(map[string]any{"contractVersion": "1.1.0"})
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	if _, err := c.Snapshot(context.Background(), []string{"system", "alerts"}, 10); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	// A console showing one panel must not make the backend build sixteen.
	if !strings.Contains(gotQuery, "domains=system,alerts") {
		t.Errorf("query = %q, want the requested domains", gotQuery)
	}
	if !strings.Contains(gotQuery, "limit=10") {
		t.Errorf("query = %q, want the limit", gotQuery)
	}
}

func TestServerMessageIsPreferredOverAStatusLine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"message": "Unknown operations domain(s): torrentz"})
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	_, err := c.Snapshot(context.Background(), []string{"torrentz"}, 0)
	if err == nil || !strings.Contains(err.Error(), "torrentz") {
		t.Fatalf("the server's own message should reach the operator, got %v", err)
	}
}

func TestHTMLErrorPageDoesNotReachTheTerminal(t *testing.T) {
	// A proxy in front of the API returns a screenful of markup that tells an
	// operator nothing they cannot get from "502".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/refresh" {
			json.NewEncoder(w).Encode(map[string]any{"accessToken": "a", "refreshToken": "b", "expiresIn": 900})
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html><head><title>502 Bad Gateway</title></head><body>…</body></html>"))
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	c.SetRefreshToken("stored")
	_, err := c.Snapshot(context.Background(), nil, 0)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "<html>") {
		t.Errorf("raw markup must not be printed at a terminal: %q", err)
	}
}

func TestPermitsIsExactNotPrefix(t *testing.T) {
	caps := &Capabilities{PermittedDomains: []string{"media"}}
	if !caps.Permits("media") {
		t.Error("an exact match must be permitted")
	}
	// "mediaIntake" starts with "media" and is a different permission.
	if caps.Permits("mediaIntake") {
		t.Error("domain matching must be exact, not a prefix")
	}
}
