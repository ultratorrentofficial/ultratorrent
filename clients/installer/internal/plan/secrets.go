package plan

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

// Secrets holds the values the deployment needs and the plan must never carry.
//
// Every field is `json:"-"`. A plan is something a user may save, diff, attach
// to a bug report or paste into a forum, and a struct that *could* serialize a
// signing key eventually will. `TestPlanNeverSerializesSecrets` marshals a plan
// with these populated and fails if any value appears in the output.
//
// These are written to exactly one place: `.env`, created 0600 before anything
// is written into it.
type Secrets struct {
	PostgresPassword string `json:"-"`
	JWTAccessSecret  string `json:"-"`
	JWTRefreshSecret string `json:"-"`
	EncryptionKey    string `json:"-"`
	AdminPassword    string `json:"-"`
	// EnginePassword is the bundled torrent engine's Web UI password.
	//
	// Generated so the engine never issues the temporary password it otherwise
	// prints to its log — a credential that is racy to catch, ends up in
	// `docker logs`, and cannot be automated around.
	EnginePassword string `json:"-"`
}

// Character sets for generation.
//
// The token alphabet is base62 — deliberately no punctuation. Two independent
// reasons, both learned from the deployment rather than invented:
//
//   - Compose DERIVES `DATABASE_URL` from `POSTGRES_PASSWORD` by string
//     interpolation, so `@`, `:`, `/` or `?` in the password silently produces a
//     malformed URL and an authentication failure that looks like a wrong
//     password. `.env.example` says "ALPHANUMERIC" in a comment; here it is
//     enforced.
//   - A secret that survives being pasted through a shell, a YAML file and an
//     editor without quoting questions is worth more than the handful of extra
//     bits punctuation would buy at this length.
const alphanumeric = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// SecretLength is how long every generated secret is.
//
// The platform's own gate (`findInsecureSecrets`) requires ≥32 characters. 48 of
// base62 is ~285 bits, comfortably past the requirement without being unwieldy
// in a file a human may have to look at. `.env.example` also suggests 48 for the
// JWT secrets, so this matches what the documentation already tells operators.
const SecretLength = 48

// AdminPasswordLength is shorter because a human types this one once.
//
// 24 of base62 is ~142 bits — far beyond anything guessable — while still being
// possible to read off a screen and into a password manager without error.
const AdminPasswordLength = 24

// GenerateSecrets mints every secret the deployment requires.
//
// Uses crypto/rand exclusively. There is no seeded fallback and no "if this
// fails, use something weaker" path: an installer that quietly degraded its
// entropy would produce a deployment that looks identical to a good one.
func GenerateSecrets() (*Secrets, error) {
	s := &Secrets{}
	for _, field := range []struct {
		name   string
		target *string
		length int
	}{
		{"POSTGRES_PASSWORD", &s.PostgresPassword, SecretLength},
		{"JWT_ACCESS_SECRET", &s.JWTAccessSecret, SecretLength},
		{"JWT_REFRESH_SECRET", &s.JWTRefreshSecret, SecretLength},
		{"ENCRYPTION_KEY", &s.EncryptionKey, SecretLength},
		{"ADMIN_PASSWORD", &s.AdminPassword, AdminPasswordLength},
		{"ENGINE_PASSWORD", &s.EnginePassword, AdminPasswordLength},
	} {
		value, err := randomToken(field.length)
		if err != nil {
			return nil, fmt.Errorf("generating %s: %w", field.name, err)
		}
		*field.target = value
	}
	return s, nil
}

// randomToken returns n characters drawn uniformly from the alphabet.
//
// Rejection-free by construction: `rand.Int` over the alphabet length is already
// uniform, where the tempting `b % len(alphabet)` would bias toward the first
// few characters. The bias would be small and completely invisible, which is
// exactly why it is worth avoiding.
func randomToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token length must be positive, got %d", n)
	}
	max := big.NewInt(int64(len(alphanumeric)))
	var b strings.Builder
	b.Grow(n)
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(alphanumeric[idx.Int64()])
	}
	return b.String(), nil
}

// Validate checks the generated (or supplied) secrets against the platform's own
// boot gate.
//
// This mirrors `findInsecureSecrets()` in apps/backend/src/config/configuration.ts
// on purpose: the backend refuses to boot on a violation, and discovering that
// after the containers are up means a failed install with a confusing error. The
// duplication is deliberate and the comment is the contract — if that function
// gains a rule, this one must too, and the integration test that boots the stack
// is what catches the drift.
func (s *Secrets) Validate() []string {
	var problems []string

	check := func(name, value string) {
		switch {
		case value == "":
			problems = append(problems, name+" is empty")
		case len(value) < 32:
			problems = append(problems, fmt.Sprintf(
				"%s is %d characters; the backend requires at least 32", name, len(value)))
		}
	}
	check("JWT_ACCESS_SECRET", s.JWTAccessSecret)
	check("JWT_REFRESH_SECRET", s.JWTRefreshSecret)
	check("ENCRYPTION_KEY", s.EncryptionKey)

	if s.EncryptionKey != "" && s.EncryptionKey == s.JWTAccessSecret {
		problems = append(problems, "ENCRYPTION_KEY must differ from JWT_ACCESS_SECRET")
	}
	if s.JWTRefreshSecret != "" && s.JWTRefreshSecret == s.JWTAccessSecret {
		problems = append(problems, "JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET")
	}

	if s.PostgresPassword == "" {
		problems = append(problems, "POSTGRES_PASSWORD is empty")
	} else if !isAlphanumeric(s.PostgresPassword) {
		// Not cosmetic: Compose builds DATABASE_URL by interpolating this value,
		// so punctuation produces a malformed URL and an auth failure that reads
		// like a wrong password.
		problems = append(problems, "POSTGRES_PASSWORD must be alphanumeric — "+
			"Compose interpolates it into DATABASE_URL, where punctuation corrupts the URL")
	}
	if s.AdminPassword == "" {
		problems = append(problems, "ADMIN_PASSWORD is empty")
	}
	return problems
}

func isAlphanumeric(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

// Redact replaces a secret with a fixed marker for display and logs.
//
// A fixed marker rather than a length-preserving mask: `********` leaks nothing,
// while a mask that matched the real length would hand an attacker the search
// space for free.
func Redact(string) string { return "********" }
