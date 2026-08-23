package plan

import (
	"strings"
	"testing"
)

// Validation exists to catch a bad plan before anything on the host changes.
// Each test below is a mistake a real operator can make, and the assertion is
// that the installer refuses (or warns) rather than deploying something broken.

func valid() *Plan {
	p := Recommended("test")
	p.Finalize()
	return p
}

func problemsFor(t *testing.T, p *Plan) string {
	t.Helper()
	var b strings.Builder
	for _, problem := range p.Validate() {
		b.WriteString(problem.String())
		b.WriteString("\n")
	}
	return b.String()
}

func TestRecommendedPlanIsValid(t *testing.T) {
	// The default path must not require the user to fix anything.
	if got := Errors(valid().Validate()); len(got) != 0 {
		t.Fatalf("the recommended defaults do not validate: %v", got)
	}
}

func TestInstallDirectoryMustBeAbsolute(t *testing.T) {
	// A relative path resolves against wherever the installer happened to run.
	p := valid()
	p.InstallDirectory = "ultratorrent"
	if !strings.Contains(problemsFor(t, p), "absolute") {
		t.Error("a relative install directory should be refused")
	}

	p = valid()
	p.InstallDirectory = "/opt/../etc/ultratorrent"
	if !strings.Contains(problemsFor(t, p), "'..'") {
		t.Error("a traversing install directory should be refused")
	}
}

func TestProxyChoicesAreMutuallyExclusive(t *testing.T) {
	// The bundled proxy binds 80 and 443, which an existing proxy already holds.
	p := valid()
	p.Networking.BehindReverseProxy = true
	p.Networking.UseBundledProxy = true
	out := problemsFor(t, p)
	if !strings.Contains(out, "80") || !strings.Contains(out, "443") {
		t.Errorf("the conflict should name the ports at stake:\n%s", out)
	}
}

func TestPortCollisionsAreCaught(t *testing.T) {
	/*
	 * The default that makes this real: FRONTEND_PORT is 8080 and qBittorrent's
	 * Web UI defaults to 8081 *because* 8080 is taken. A user who "tidies" them
	 * to the same number gets a stack that half-starts.
	 */
	p := valid()
	p.Torrent.WebUIPort = p.Networking.FrontendPort
	out := problemsFor(t, p)
	if !strings.Contains(out, "claimed by both") {
		t.Errorf("a duplicate host port should be refused:\n%s", out)
	}
}

func TestPrivilegedPortWarnsButDoesNotRefuse(t *testing.T) {
	// 80 and 443 are exactly where a proxy belongs; refusing would be wrong.
	p := valid()
	p.Networking.FrontendPort = 80
	if Fatal(p.Validate()) {
		t.Error("a privileged port should warn, not block")
	}
	if !strings.Contains(problemsFor(t, p), "privileged") {
		t.Error("a privileged port should be mentioned")
	}
}

func TestDatabaseIdentifiersAreConstrained(t *testing.T) {
	// User and name are interpolated into DATABASE_URL by Compose.
	for _, bad := range []string{"ultra torrent", "ultra-torrent", "ultra;drop", "ultra@host"} {
		p := valid()
		p.Database.User = bad
		if !Fatal(p.Validate()) {
			t.Errorf("database user %q should be refused", bad)
		}
	}
	p := valid()
	p.Database.User = "ultra_torrent2"
	if Fatal(p.Validate()) {
		t.Error("a normal identifier should be accepted")
	}
}

func TestStorageModeAndPathMustAgree(t *testing.T) {
	// A media root that will be ignored is worse than no media root: the user
	// believes their files are going somewhere they are not.
	p := valid()
	p.Storage.Mode = StorageVolume
	p.Storage.MediaRoot = "/srv/media"
	if !strings.Contains(problemsFor(t, p), "would be ignored") {
		t.Error("a media root with volume storage should be refused")
	}

	p = valid()
	p.Storage.Mode = StorageBind
	if !strings.Contains(problemsFor(t, p), "host path is required") {
		t.Error("bind storage without a path should be refused")
	}
}

func TestMediaInsideTheInstallDirectoryWarns(t *testing.T) {
	// Not refused — some people genuinely want one tree — but worth saying,
	// because a reinstall or a permissions change then reaches the media too.
	p := valid()
	p.Storage.Mode = StorageBind
	p.Storage.MediaRoot = p.InstallDirectory + "/media"
	if Fatal(p.Validate()) {
		t.Error("media under the install directory should warn, not block")
	}
	if !strings.Contains(problemsFor(t, p), "keep media separate") {
		t.Error("the warning should explain why it matters")
	}
}

func TestSiblingPathIsNotTreatedAsNested(t *testing.T) {
	// /opt/ultratorrent-data is NOT inside /opt/ultratorrent.
	p := valid()
	p.InstallDirectory = "/opt/ultratorrent"
	p.Storage.Mode = StorageBind
	p.Storage.MediaRoot = "/opt/ultratorrent-data"
	if strings.Contains(problemsFor(t, p), "keep media separate") {
		t.Error("a sibling directory must not be treated as nested")
	}
}

func TestLibraryPathsMustBeVisibleToContainers(t *testing.T) {
	// /downloads is the only tree the containers share; a library anywhere else
	// exists in no container and would simply be empty.
	p := valid()
	p.Storage.Libraries = []Library{{Name: "Movies", Kind: "movie", Path: "/srv/media/Movies"}}
	if !strings.Contains(problemsFor(t, p), "/downloads") {
		t.Error("a library outside /downloads should be refused")
	}

	p = valid()
	p.Storage.Libraries = []Library{{Name: "Movies", Kind: "movie", Path: "/downloads/Movies"}}
	if Fatal(p.Validate()) {
		t.Error("a library under /downloads should be accepted")
	}
}

func TestIntakeStagingMustNotBeALibrary(t *testing.T) {
	// Importing would move files into the directory they are staged in.
	p := valid()
	p.Intake = Intake{Enabled: true, StagingPath: "/downloads/Staging", ProfileName: "Default"}
	p.Storage.Libraries = []Library{{Name: "TV", Kind: "tv", Path: "/downloads/Staging"}}
	if !strings.Contains(problemsFor(t, p), "staged in") {
		t.Error("a library sharing the staging path should be refused")
	}
}

func TestFlareSolverrWithoutProwlarrIsRefused(t *testing.T) {
	// Alone it is a container nothing talks to.
	p := valid()
	p.Companions.FlareSolverr = true
	p.Companions.Prowlarr = false
	if !strings.Contains(problemsFor(t, p), "only used by Prowlarr") {
		t.Error("FlareSolverr without Prowlarr should be refused")
	}
}

func TestExternalEngineNeedsAURL(t *testing.T) {
	p := valid()
	p.Torrent.Engine = EngineExternal
	if !strings.Contains(problemsFor(t, p), "externalUrl") {
		t.Error("an external engine with no URL should be refused")
	}
}

func TestUnknownEnumsAreRefusedNotIgnored(t *testing.T) {
	// A typo in a hand-written plan file must not silently become a default.
	p := valid()
	p.Torrent.Engine = Engine("qbitorrent") // one 't'
	if !Fatal(p.Validate()) {
		t.Error("an unknown engine should be refused")
	}
	p = valid()
	p.Storage.Mode = StorageMode("bindmount")
	if !Fatal(p.Validate()) {
		t.Error("an unknown storage mode should be refused")
	}
}

func TestHTTPPublicURLWarnsWithoutBlocking(t *testing.T) {
	// A trusted LAN over HTTP is a legitimate choice; blocking it would be the
	// installer overruling the operator about their own network.
	p := valid()
	p.Networking.PublicURL = "http://media.lan:8080"
	if Fatal(p.Validate()) {
		t.Error("plain HTTP should warn, not block")
	}
	if !strings.Contains(problemsFor(t, p), "HTTPS") {
		t.Error("the warning should recommend HTTPS for internet exposure")
	}

	// Loopback needs no such warning — nothing is exposed.
	p = valid()
	p.Networking.PublicURL = "http://localhost:8080"
	if strings.Contains(problemsFor(t, p), "HTTPS") {
		t.Error("loopback should not be warned about")
	}
}

func TestValidateReportsEveryProblemAtOnce(t *testing.T) {
	// A wizard that reports one mistake per run is a wizard run five times.
	p := valid()
	p.InstallDirectory = "relative"
	p.Database.User = ""
	p.Admin.Email = "not-an-email"
	if got := len(Errors(p.Validate())); got < 3 {
		t.Errorf("expected at least 3 errors together, got %d", got)
	}
}

// --- Secrets ---------------------------------------------------------------

func TestGeneratedSecretsSatisfyTheBackendGate(t *testing.T) {
	// Mirrors findInsecureSecrets() in the backend. If this drifts, the stack
	// deploys and then refuses to boot — the worst possible time to find out.
	s, err := GenerateSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("generated secrets do not satisfy the backend's own rules: %v", problems)
	}
	for _, v := range []string{s.JWTAccessSecret, s.JWTRefreshSecret, s.EncryptionKey} {
		if len(v) < 32 {
			t.Errorf("secret is %d characters; the backend requires 32", len(v))
		}
	}
}

func TestGeneratedSecretsAreDistinct(t *testing.T) {
	// Reusing one value for two purposes means a leak of either forges the other
	// — and the backend refuses to boot on it.
	s, err := GenerateSecrets()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, v := range []string{
		s.PostgresPassword, s.JWTAccessSecret, s.JWTRefreshSecret,
		s.EncryptionKey, s.AdminPassword,
	} {
		if seen[v] {
			t.Fatal("two generated secrets are identical")
		}
		seen[v] = true
	}
}

func TestTwoRunsDoNotRepeat(t *testing.T) {
	a, _ := GenerateSecrets()
	b, _ := GenerateSecrets()
	if a.JWTAccessSecret == b.JWTAccessSecret {
		t.Fatal("two runs produced the same secret — the source is not random")
	}
}

func TestPostgresPasswordIsAlphanumeric(t *testing.T) {
	/*
	 * Not cosmetic. Compose builds DATABASE_URL by interpolating this value, so
	 * punctuation yields a malformed URL and an authentication failure that
	 * reads exactly like a wrong password.
	 */
	for i := 0; i < 50; i++ {
		s, err := GenerateSecrets()
		if err != nil {
			t.Fatal(err)
		}
		if !isAlphanumeric(s.PostgresPassword) {
			t.Fatalf("generated a non-alphanumeric database password: %q", s.PostgresPassword)
		}
	}
}

func TestSuppliedSecretsAreCheckedToo(t *testing.T) {
	// Advanced mode lets an operator bring their own; the same gate applies.
	s := &Secrets{
		PostgresPassword: "p@ssw0rd",
		JWTAccessSecret:  "short",
		JWTRefreshSecret: "short",
		EncryptionKey:    "short",
		AdminPassword:    "",
	}
	problems := strings.Join(s.Validate(), "\n")
	for _, want := range []string{"at least 32", "alphanumeric", "ADMIN_PASSWORD is empty"} {
		if !strings.Contains(problems, want) {
			t.Errorf("expected a complaint containing %q, got:\n%s", want, problems)
		}
	}
	if !strings.Contains(problems, "differ from JWT_ACCESS_SECRET") {
		t.Error("identical signing keys should be reported")
	}
}

func TestRedactRevealsNothing(t *testing.T) {
	// A length-preserving mask would hand over the search space for free.
	secret := "averyverylongsecretvalue1234567890"
	got := Redact(secret)
	if strings.Contains(got, secret) || len(got) == len(secret) {
		t.Errorf("redaction leaks: %q", got)
	}
}
