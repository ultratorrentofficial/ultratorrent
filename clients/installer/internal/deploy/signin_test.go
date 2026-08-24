package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The check this replaced ran inside the backend container against
// 127.0.0.1:4000. It reported a deployment verified while the web UI returned
// 502 to every request, because a frontend that was not recreated went on
// proxying to the backend's previous address. Proving the API can reach itself
// is not the same as proving anyone can reach it, so these go over the wire.

// shortPatience keeps the retrying tests from spending the real window.
func shortPatience(t *testing.T) {
	t.Helper()
	oldPatience, oldGap := signInPatience, signInRetryGap
	signInPatience, signInRetryGap = 150*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() { signInPatience, signInRetryGap = oldPatience, oldGap })
}

func serverOn(t *testing.T, h http.HandlerFunc) int {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	port, err := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	if err != nil {
		t.Fatalf("parsing test server port: %v", err)
	}
	return port
}

func TestASuccessfulSignInGoesThroughTheFrontDoor(t *testing.T) {
	var gotPath, gotBody string
	port := serverOn(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		buf := make([]byte, r.ContentLength)
		r.Body.Read(buf)
		gotBody = string(buf)
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"accessToken":"t"}`))
	})

	result := VerifySignIn(context.Background(), port, "admin", "hunter2")
	if !result.OK {
		t.Fatalf("a working sign-in was not recognised: %s", result.Explain())
	}
	if gotPath != "/api/auth/login" {
		t.Errorf("posted to %q, not the login endpoint users reach", gotPath)
	}
	if !strings.Contains(gotBody, "admin") {
		t.Errorf("did not send the credentials: %q", gotBody)
	}
}

// The failure the rewrite exists for. It must be named as a proxy problem, not
// as a wrong password, or it sends someone to reset credentials that are fine.
func TestABadGatewayIsReportedAsTheUIBeingUnreachable(t *testing.T) {
	shortPatience(t)
	port := serverOn(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	result := VerifySignIn(context.Background(), port, "admin", "hunter2")
	if result.OK {
		t.Fatal("a 502 was treated as a working sign-in")
	}
	explain := result.Explain()
	if !strings.Contains(explain, "502") || !strings.Contains(explain, "cannot reach") {
		t.Errorf("a proxy failure was not explained as one: %q", explain)
	}
	if strings.Contains(strings.ToLower(explain), "password") {
		t.Errorf("blamed the password for a proxy failure: %q", explain)
	}
}

// A 401 is a definite answer, so it must not spend the login throttle retrying.
func TestARefusedPasswordIsNotRetried(t *testing.T) {
	var attempts int
	port := serverOn(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusUnauthorized)
	})
	result := VerifySignIn(context.Background(), port, "admin", "wrong")
	if result.OK {
		t.Fatal("a 401 was treated as success")
	}
	if attempts != 1 {
		t.Errorf("retried a definite refusal %d times", attempts)
	}
	if !strings.Contains(result.Explain(), "401") {
		t.Errorf("did not say the password was refused: %q", result.Explain())
	}
}

func TestNothingListeningIsSaidPlainly(t *testing.T) {
	shortPatience(t)
	// Port 1 on loopback: reserved, and nothing binds it.
	result := VerifySignIn(context.Background(), 1, "admin", "hunter2")
	if result.OK {
		t.Fatal("reported success against a closed port")
	}
	if !strings.Contains(result.Explain(), "nothing is listening") {
		t.Errorf("unclear about a closed port: %q", result.Explain())
	}
}

func TestNoPasswordIsNotAFailedSignIn(t *testing.T) {
	result := VerifySignIn(context.Background(), 1, "admin", "")
	if result.OK {
		t.Error("claimed a sign-in with no password")
	}
	if result.Err == nil {
		t.Error("gave no reason for not trying")
	}
}
