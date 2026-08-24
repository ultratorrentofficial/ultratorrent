package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// How long a warming-up stack is given, and how often it is asked.
//
// Variables rather than constants so the tests can shorten them: at their real
// values every test of a failing sign-in would wait the full window, and a test
// suite that runs on every build is not the place to spend a minute proving
// that waiting works.
var (
	signInPatience = 45 * time.Second
	signInRetryGap = 3 * time.Second
)

// SignIn is the result of trying to sign in exactly as a user would.
type SignIn struct {
	OK      bool
	Status  int
	Through string // the address that was tried
	Err     error
}

// VerifySignIn signs in through the PUBLISHED web UI.
//
// This deliberately goes the whole way round — host port, nginx, backend —
// because the earlier check did not, and that gap hid a real outage. It ran
// `node -e` inside the backend container against 127.0.0.1:4000, which proves
// the API answers itself and nothing about whether anyone can reach it. A
// frontend holding a stale upstream address returned 502 to every request in
// the browser while that check reported the deployment verified.
//
// A deployment is usable when its front door opens. Anything short of that is
// a component test wearing the words of an end-to-end one.
func VerifySignIn(ctx context.Context, port int, username, password string) SignIn {
	addr := fmt.Sprintf("http://127.0.0.1:%d", port)
	result := SignIn{Through: addr + "/api/auth/login"}
	if username == "" || password == "" {
		result.Err = fmt.Errorf("no administrator credentials to try")
		return result
	}

	body, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		result.Err = err
		return result
	}

	// The stack has just been reported healthy, but nginx may still be settling
	// and the backend's first request after a restart can be slow. Retry briefly
	// rather than turn a warm-up into a failed deployment.
	deadline := time.Now().Add(signInPatience)
	for attempt := 1; ; attempt++ {
		status, err := postLogin(ctx, result.Through, body)
		result.Status, result.Err = status, err
		switch {
		case err == nil && status >= 200 && status < 300:
			result.OK = true
			return result
		case status == http.StatusUnauthorized:
			// A definite answer: the door works and the key does not. Retrying
			// would only spend the login throttle.
			return result
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return result
		}
		select {
		case <-ctx.Done():
			return result
		case <-time.After(signInRetryGap):
		}
	}
}

func postLogin(ctx context.Context, url string, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout: 20 * time.Second,
		// Never follow a redirect to somewhere else: this is a local check.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// Explain turns a sign-in result into something worth printing.
func (s SignIn) Explain() string {
	switch {
	case s.OK:
		return "sign-in verified through " + s.Through
	case s.Status == http.StatusBadGateway:
		// The exact failure this check was rewritten to catch.
		return "the web UI cannot reach the API (502 from the proxy)"
	case s.Status == http.StatusUnauthorized:
		return "the administrator's password was refused (401)"
	case s.Status != 0:
		return fmt.Sprintf("signing in returned %d", s.Status)
	case s.Err != nil && isConnRefused(s.Err):
		return "nothing is listening on " + s.Through
	case s.Err != nil:
		return "the sign-in check could not be completed: " + s.Err.Error()
	}
	return "the sign-in check produced no answer"
}

func isConnRefused(err error) bool {
	var opErr *net.OpError
	if strings.Contains(err.Error(), "connection refused") {
		return true
	}
	return errors.As(err, &opErr) && opErr.Op == "dial"
}
