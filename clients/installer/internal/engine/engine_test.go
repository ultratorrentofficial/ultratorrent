package engine

import (
	"encoding/base64"
	"strings"
	"testing"
)

// goldenVerifier was computed by an INDEPENDENT implementation (Python's
// hashlib.pbkdf2_hmac) over a fixed password and salt, and the format was
// confirmed against qBittorrent 5.2.3 itself: a container started with a config
// written this way issues no temporary password and accepts the password at
// login. Two implementations agreeing on a vector the real engine also accepts
// is what makes this more than a change detector.
const (
	goldenPassword = "correct horse battery staple"
	goldenSaltB64  = "AAECAwQFBgcICQoLDA0ODw=="
	goldenVerifier = "AAECAwQFBgcICQoLDA0ODw==:hzaYXq3InP7jFNdKFTiXBaKMc6Hki6FR8fwp8lRCNSzgwBQu/67CPfP4HL9ZakyYey/St+3YqPl5YVpad7RbFQ=="
)

func TestVerifierMatchesTheGoldenVector(t *testing.T) {
	/*
	 * Every parameter here is load-bearing and none is discoverable from a
	 * failure. Get the algorithm, iteration count, key length or field order
	 * wrong and qBittorrent accepts the file as "a password is set" — it stops
	 * issuing a temporary one — while rejecting every login. The operator sees
	 * a wrong password, not a wrong format, and has nothing to go on.
	 */
	salt, err := base64.StdEncoding.DecodeString(goldenSaltB64)
	if err != nil {
		t.Fatal(err)
	}
	if got := Verifier(goldenPassword, salt); got != goldenVerifier {
		t.Errorf("Verifier mismatch\n got: %s\nwant: %s", got, goldenVerifier)
	}
}

func TestVerifierShape(t *testing.T) {
	v, err := NewVerifier("whatever")
	if err != nil {
		t.Fatal(err)
	}
	salt, key, found := strings.Cut(v, ":")
	if !found {
		t.Fatalf("verifier is not salt:key — %q", v)
	}
	saltBytes, err := base64.StdEncoding.DecodeString(salt)
	if err != nil {
		t.Fatalf("salt is not base64: %v", err)
	}
	keyBytes, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		t.Fatalf("key is not base64: %v", err)
	}
	if len(saltBytes) != pbkdf2SaltLength {
		t.Errorf("salt is %d bytes, want %d", len(saltBytes), pbkdf2SaltLength)
	}
	if len(keyBytes) != pbkdf2KeyLength {
		t.Errorf("key is %d bytes, want %d", len(keyBytes), pbkdf2KeyLength)
	}
}

func TestEverySaltIsDifferent(t *testing.T) {
	// A fixed salt would make one precomputation cover every installation.
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		v, err := NewVerifier("same password every time")
		if err != nil {
			t.Fatal(err)
		}
		if seen[v] {
			t.Fatal("a verifier repeated — the salt is not random")
		}
		seen[v] = true
	}
}

func TestPasswordNeverAppearsInTheConfig(t *testing.T) {
	const password = "SENTINELpassword123"
	v, err := NewVerifier(password)
	if err != nil {
		t.Fatal(err)
	}
	content := RenderConfigWithPassword(Settings{
		Username: "admin", Port: 8080,
		SavePath: "/downloads/", TempPath: "/downloads/incomplete/",
	}, v)
	if strings.Contains(content, password) {
		t.Fatal("the plaintext password reached the config file")
	}
	if !strings.Contains(content, "Password_PBKDF2=\"@ByteArray("+v+")\"") {
		t.Errorf("the verifier is not in qBittorrent's expected form:\n%s", content)
	}
}

func TestConfigAcceptsTheLegalNotice(t *testing.T) {
	// Without it qBittorrent refuses to start unattended, which in a container
	// is a boot loop with no obvious cause.
	if !strings.Contains(RenderConfig(Settings{}), "[LegalNotice]\nAccepted=true") {
		t.Error("the legal notice must be pre-accepted")
	}
}

func TestHostHeaderValidationIsOnlyRelaxedWhenAsked(t *testing.T) {
	/*
	 * qBittorrent checks that the port in a request's Host header matches its own
	 * WebUI port. That check is why the shipped 8081:8080 mapping answers 401 to
	 * a browser. Relaxing it is a real, if narrow, security decision and must
	 * never be the silent default — aligning the ports is the better fix.
	 */
	base := Settings{Username: "admin", Port: 8080}
	if strings.Contains(RenderConfig(base), "HostHeaderValidation") {
		t.Error("the check must be left on unless explicitly relaxed")
	}
	base.RelaxHostHeaderValidation = true
	if !strings.Contains(RenderConfig(base), "WebUI\\HostHeaderValidation=false") {
		t.Error("relaxing it should write the setting")
	}
}

func TestConfigUsesQBittorrentsBackslashKeys(t *testing.T) {
	// A doubled backslash is silently ignored: qBittorrent reads the file, finds
	// no key it recognises, and issues a temporary password as though nothing had
	// been configured. Cost an experiment to discover.
	content := RenderConfig(Settings{Username: "admin", Port: 8080, SavePath: "/downloads/"})
	if strings.Contains(content, `\\`) {
		t.Errorf("keys must use a single backslash:\n%s", content)
	}
	for _, key := range []string{`WebUI\Port=8080`, `WebUI\Username=admin`, `WebUI\Address=*`} {
		if !strings.Contains(content, key) {
			t.Errorf("missing %q in:\n%s", key, content)
		}
	}
}
