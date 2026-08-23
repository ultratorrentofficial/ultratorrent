package plan

import (
	"bytes"
	"strings"
	"testing"
)

// The plan is the installer's contract with the user: what it shows on the
// review screen is what the executor will do. These tests pin the properties
// that make that true, and the one property that makes a saved plan safe to
// share.

func TestPlanNeverSerializesSecrets(t *testing.T) {
	/*
	 * The single most important test in this package. A plan is something a
	 * user may save, diff, attach to a bug report or paste into a forum. A
	 * struct that *can* serialize a signing key eventually will — usually the
	 * day someone adds a field and forgets the tag.
	 */
	p := Recommended("test")
	p.Secrets = &Secrets{
		PostgresPassword: "POSTGRESVALUEsentinel1234567890abcdefghij",
		JWTAccessSecret:  "ACCESSVALUEsentinel1234567890abcdefghijk",
		JWTRefreshSecret: "REFRESHVALUEsentinel1234567890abcdefghi",
		EncryptionKey:    "ENCRYPTIONVALUEsentinel1234567890abcdef",
		AdminPassword:    "ADMINVALUEsentinel12345",
	}

	var buf bytes.Buffer
	if err := p.WriteJSON(&buf); err != nil {
		t.Fatal(err)
	}
	out := buf.String()

	for _, secret := range []string{
		p.Secrets.PostgresPassword, p.Secrets.JWTAccessSecret,
		p.Secrets.JWTRefreshSecret, p.Secrets.EncryptionKey, p.Secrets.AdminPassword,
	} {
		if strings.Contains(out, secret) {
			t.Fatalf("a secret reached the serialized plan: %q", secret)
		}
	}
	// Nor may the key names appear and invite someone to fill them in.
	for _, marker := range []string{"postgresPassword", "jwtAccessSecret", "adminPassword"} {
		if strings.Contains(out, marker) {
			t.Errorf("serialized plan exposes the field %q", marker)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	p := Recommended("v1.2.3")
	p.Storage.Mode = StorageBind
	p.Storage.MediaRoot = "/srv/media"
	p.Companions.Prowlarr = true
	p.Finalize()

	var buf bytes.Buffer
	if err := p.WriteJSON(&buf); err != nil {
		t.Fatal(err)
	}
	back, err := ReadJSON(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if back.InstallerVersion != "v1.2.3" || back.Storage.MediaRoot != "/srv/media" {
		t.Errorf("round trip lost data: %+v", back)
	}
	if !back.Companions.Prowlarr {
		t.Error("round trip lost the Prowlarr selection")
	}
}

func TestReadJSONRefusesAnUnknownSchema(t *testing.T) {
	// A plan from a newer installer may hold decisions this build would silently
	// drop — and silently dropping a decision is how a stack ends up not
	// matching what its operator reviewed.
	_, err := ReadJSON(strings.NewReader(`{"schemaVersion": 999}`))
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if !strings.Contains(err.Error(), "999") {
		t.Errorf("the error should name the offending schema: %v", err)
	}
}

func TestComposeProfilesFollowTheSelections(t *testing.T) {
	cases := []struct {
		name string
		set  func(*Plan)
		want []string
	}{
		{"qbittorrent only", func(p *Plan) {}, []string{"qbittorrent"}},
		{"rtorrent", func(p *Plan) { p.Torrent.Engine = EngineRtorrent }, []string{"rtorrent"}},
		{"external engine deploys nothing", func(p *Plan) {
			p.Torrent.Engine = EngineExternal
		}, []string{}},
		{"no engine deploys nothing", func(p *Plan) {
			p.Torrent.Engine = EngineNone
		}, []string{}},
		{"prowlarr and flaresolverr", func(p *Plan) {
			p.Companions.Prowlarr = true
			p.Companions.FlareSolverr = true
		}, []string{"qbittorrent", "prowlarr", "flaresolverr"}},
		{"bundled proxy", func(p *Plan) {
			p.Networking.UseBundledProxy = true
		}, []string{"qbittorrent", "proxy"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := Recommended("test")
			c.set(p)
			got := p.ComposeProfiles()
			if strings.Join(got, ",") != strings.Join(c.want, ",") {
				t.Errorf("profiles = %v, want %v", got, c.want)
			}
		})
	}
}

func TestSSRFAllowHostsProtectsTheBundledIndexer(t *testing.T) {
	/*
	 * Getting this wrong is invisible: auto-downloads fail with a blocked-address
	 * error buried in a log while every container looks healthy. With the bundled
	 * Prowlarr the installer must NOT write the variable, so the Compose default
	 * (`prowlarr`) stands.
	 */
	withProwlarr := Recommended("test")
	withProwlarr.Companions.Prowlarr = true
	if _, write := withProwlarr.SSRFAllowHosts(); write {
		t.Error("with bundled Prowlarr the installer must inherit the Compose default, not overwrite it")
	}

	// Without it, the guard should be explicitly at full strength rather than
	// inheriting a default that trusts a Prowlarr this deployment does not run.
	without := Recommended("test")
	value, write := without.SSRFAllowHosts()
	if !write || value != "" {
		t.Errorf("without Prowlarr expected an explicit empty value, got (%q, %v)", value, write)
	}
}

func TestPublishedPortsCoversEverythingBound(t *testing.T) {
	p := Recommended("test")
	p.Companions.Prowlarr = true
	p.Companions.PublishProwlarrUI = true
	p.Networking.UseBundledProxy = true

	bound := map[int]bool{}
	for _, b := range p.PublishedPorts() {
		bound[b.Port] = true
	}
	for _, want := range []int{DefaultFrontendPort, DefaultQbittorrentPort, DefaultProwlarrPort, 80, 443} {
		if !bound[want] {
			t.Errorf("port %d is bound but not reported; a conflict check would miss it", want)
		}
	}

	// A slice, not a map: a map keyed by port silently deduplicates, which would
	// make the collision check structurally incapable of firing.
	clash := Recommended("test")
	clash.Torrent.WebUIPort = clash.Networking.FrontendPort
	if len(clash.PublishedPorts()) != 2 {
		t.Error("two services claiming one port must still be two bindings")
	}
}

func TestFinalizeRecordsWarningsNotErrors(t *testing.T) {
	p := Recommended("test")
	p.Torrent.Engine = EngineNone // a warning, not a refusal
	p.Finalize()

	if len(p.Warnings) == 0 {
		t.Fatal("expected the no-engine warning to be recorded")
	}
	for _, w := range p.Warnings {
		if strings.Contains(w, "required") {
			t.Errorf("a fatal problem leaked into warnings: %q", w)
		}
	}
}

func TestFinalizeIsIdempotent(t *testing.T) {
	// Reconfigure calls it again after each edit; warnings must not accumulate.
	p := Recommended("test")
	p.Torrent.Engine = EngineNone
	p.Finalize()
	first := len(p.Warnings)
	p.Finalize()
	if len(p.Warnings) != first {
		t.Errorf("warnings grew on a second Finalize: %d then %d", first, len(p.Warnings))
	}
}
