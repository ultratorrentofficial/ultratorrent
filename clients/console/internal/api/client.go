package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Errors a caller is expected to handle differently from a generic failure.
var (
	// ErrUnauthorized means the credentials or the stored session are no good.
	ErrUnauthorized = errors.New("not authorized")
	// ErrForbidden means authenticated but lacking console.view.
	ErrForbidden = errors.New("this account may not use the console")
	// ErrIncompatible means the server speaks a different contract MAJOR.
	ErrIncompatible = errors.New("incompatible operations contract")
)

// Client is a read-only client for the operations surface.
//
// It performs exactly four requests in its life: login, refresh, capabilities
// and snapshot. There is no method here that changes anything on the server,
// and that is a deliberate property of the type rather than of its callers —
// a console that could act would be a management client with a second
// authorization story, which is the thing the design forbids.
type Client struct {
	baseURL string
	http    *http.Client

	mu           sync.Mutex
	accessToken  string
	refreshToken string
	// expiry of the access token, so a refresh happens BEFORE a 401 rather
	// than as a reaction to one. A console redrawing every few seconds would
	// otherwise spend one failed request per refresh window, every window.
	accessExpiry time.Time

	// onRefresh is called whenever the refresh token rotates, so the caller can
	// persist it. Rotation means the previous token is dead: failing to store
	// the new one logs the user out on next launch.
	onRefresh func(refreshToken string)
}

// New builds a client for a server root such as https://ut.example.com.
func New(baseURL string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: timeout},
	}
}

// OnRefresh registers the callback that persists a rotated refresh token.
func (c *Client) OnRefresh(fn func(string)) { c.onRefresh = fn }

// SetRefreshToken seeds a stored session.
func (c *Client) SetRefreshToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshToken = token
}

type tokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
	User         struct {
		Username string   `json:"username"`
		Roles    []string `json:"roles"`
	} `json:"user"`
}

// Login exchanges credentials for a session.
//
// totp may be empty; the server decides whether it is required and says so.
func (c *Client) Login(ctx context.Context, username, password, totp string) error {
	body := map[string]string{"username": username, "password": password}
	if totp != "" {
		body["totp"] = totp
	}
	var out tokenResponse
	if err := c.do(ctx, http.MethodPost, "/api/auth/login", body, "", &out); err != nil {
		return err
	}
	c.storeTokens(out)
	return nil
}

// Username returns who the stored session belongs to, once known.
func (c *Client) storeTokens(t tokenResponse) {
	c.mu.Lock()
	c.accessToken = t.AccessToken
	if t.RefreshToken != "" {
		c.refreshToken = t.RefreshToken
	}
	ttl := time.Duration(t.ExpiresIn) * time.Second
	if ttl <= 0 {
		// The server reports expiry in seconds; if it ever stops, assume the
		// documented 15 minutes and refresh early rather than never.
		ttl = 15 * time.Minute
	}
	// Refresh a minute early. A token that expires mid-render produces a blank
	// panel and an error toast for something the client could have avoided.
	c.accessExpiry = time.Now().Add(ttl - time.Minute)
	token := c.refreshToken
	c.mu.Unlock()

	if c.onRefresh != nil && token != "" {
		c.onRefresh(token)
	}
}

// refresh rotates the session. Callers hold no lock.
func (c *Client) refresh(ctx context.Context) error {
	c.mu.Lock()
	token := c.refreshToken
	c.mu.Unlock()
	if token == "" {
		return ErrUnauthorized
	}
	var out tokenResponse
	if err := c.do(ctx, http.MethodPost, "/api/auth/refresh", map[string]string{"refreshToken": token}, "", &out); err != nil {
		return err
	}
	c.storeTokens(out)
	return nil
}

// authorize returns a usable access token, refreshing first if it is close to
// expiry. Serialised so a burst of concurrent panels cannot each rotate the
// refresh token and invalidate one another.
func (c *Client) authorize(ctx context.Context) (string, error) {
	c.mu.Lock()
	token := c.accessToken
	expiry := c.accessExpiry
	c.mu.Unlock()

	if token != "" && time.Now().Before(expiry) {
		return token, nil
	}
	if err := c.refresh(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.accessToken, nil
}

// AccessToken returns a currently-valid access token, refreshing if needed.
//
// Exposed for the realtime listener, which authenticates its socket with the
// same identity as the REST calls. It goes through authorize() rather than
// reading the field so a socket reconnecting an hour into a session gets a
// live token instead of the expired one the console started with.
func (c *Client) AccessToken(ctx context.Context) (string, error) {
	return c.authorize(ctx)
}

// Capabilities fetches the handshake and verifies the contract major.
func (c *Client) Capabilities(ctx context.Context) (*Capabilities, error) {
	token, err := c.authorize(ctx)
	if err != nil {
		return nil, err
	}
	var caps Capabilities
	if err := c.do(ctx, http.MethodGet, "/api/operations/capabilities", nil, token, &caps); err != nil {
		return nil, err
	}
	major, err := majorOf(caps.ContractVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: server reported version %q", ErrIncompatible, caps.ContractVersion)
	}
	if major != ContractMajor {
		return &caps, fmt.Errorf(
			"%w: this console speaks %d.x, the server speaks %s",
			ErrIncompatible, ContractMajor, caps.ContractVersion,
		)
	}
	return &caps, nil
}

// Snapshot fetches one reading. domains may be empty for all of them.
func (c *Client) Snapshot(ctx context.Context, domains []string, limit int) (*Snapshot, error) {
	token, err := c.authorize(ctx)
	if err != nil {
		return nil, err
	}
	path := "/api/operations/snapshot"
	q := make([]string, 0, 2)
	if len(domains) > 0 {
		q = append(q, "domains="+strings.Join(domains, ","))
	}
	if limit > 0 {
		q = append(q, "limit="+strconv.Itoa(limit))
	}
	if len(q) > 0 {
		path += "?" + strings.Join(q, "&")
	}
	var snap Snapshot
	if err := c.do(ctx, http.MethodGet, path, nil, token, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

// do performs one request and decodes into out.
//
// A 401 is NOT retried here. The retry belongs to authorize(), which knows
// whether a refresh is possible; retrying at this level would turn a genuinely
// revoked account into an infinite loop of refresh attempts.
func (c *Client) do(ctx context.Context, method, path string, body any, token string, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "UltraTorrent-Console")

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}

	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return ErrUnauthorized
	case res.StatusCode == http.StatusForbidden:
		return ErrForbidden
	case res.StatusCode >= 400:
		return fmt.Errorf("%s %s: %s", method, path, serverMessage(raw, res.StatusCode))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// serverMessage pulls Nest's `message` out of an error body.
//
// Falls back to the status line rather than dumping the raw body at a terminal:
// an HTML error page from a proxy in front of the API is a screenful of markup
// that tells an operator nothing they cannot get from "502".
func serverMessage(raw []byte, status int) string {
	var payload struct {
		Message any `json:"message"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil && payload.Message != nil {
		switch m := payload.Message.(type) {
		case string:
			return m
		case []any:
			parts := make([]string, 0, len(m))
			for _, item := range m {
				parts = append(parts, fmt.Sprint(item))
			}
			if len(parts) > 0 {
				return strings.Join(parts, "; ")
			}
		}
	}
	return http.StatusText(status)
}

func majorOf(version string) (int, error) {
	parts := strings.SplitN(version, ".", 2)
	if len(parts) == 0 || parts[0] == "" {
		return 0, errors.New("empty version")
	}
	return strconv.Atoi(parts[0])
}
