package companion

import (
	"encoding/hex"
	"strings"
	"testing"
)

func TestAPIKeyIsProwlarrShaped(t *testing.T) {
	// 32 hex characters. Prowlarr accepts what it is given, so the shape only has
	// to be recognisable to a human comparing it against the UI.
	key, err := NewAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 32 {
		t.Errorf("key is %d characters, want 32", len(key))
	}
	if _, err := hex.DecodeString(key); err != nil {
		t.Errorf("key is not hex: %v", err)
	}
}

func TestEveryAPIKeyIsDifferent(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		key, err := NewAPIKey()
		if err != nil {
			t.Fatal(err)
		}
		if seen[key] {
			t.Fatal("an API key repeated")
		}
		seen[key] = true
	}
}

func TestConfigCarriesTheKeyAndLittleElse(t *testing.T) {
	/*
	 * Deliberately minimal. Prowlarr fills in the rest on first start and keeps
	 * what it was given (verified against 2.4.0), so writing more would be a set
	 * of defaults to drift from Prowlarr's own without anyone noticing.
	 */
	config := RenderProwlarrConfig(ProwlarrSettings{APIKey: "abc123", Port: 9696})
	if !strings.Contains(config, "<ApiKey>abc123</ApiKey>") {
		t.Errorf("the key is not in the file:\n%s", config)
	}
	if !strings.Contains(config, "<Port>9696</Port>") {
		t.Error("the port should be set")
	}
	// Prowlarr runs from an image; its own updater must stay out of it.
	if !strings.Contains(config, "<UpdateMechanism>Docker</UpdateMechanism>") {
		t.Error("the update mechanism should be Docker")
	}
}

func TestAuthenticationIsNeverConfigured(t *testing.T) {
	/*
	 * Measured against Prowlarr 2.4.0, and every option is wrong for a published
	 * UI: DisabledForLocalAddresses serves the application unauthenticated
	 * through a published port (every request arrives from the Docker gateway, a
	 * private address); Enabled redirects to a login page that cannot create the
	 * first account, and Prowlarr keeps users in its own database, so seeding one
	 * would mean writing into another application's tables.
	 *
	 * So the installer writes none of them and keeps the UI internal instead.
	 */
	for _, published := range []bool{true, false} {
		config := RenderProwlarrConfig(ProwlarrSettings{APIKey: "k", Port: 9696, PublishUI: published})
		if strings.Contains(config, "<AuthenticationRequired>") ||
			strings.Contains(config, "<AuthenticationMethod>") {
			t.Errorf("publishUI=%v: authentication must not be configured:\n%s", published, config)
		}
	}
}

func TestPublishingTheUISaysWhatToDoAboutIt(t *testing.T) {
	// If the operator publishes it anyway, the consequence has to be stated
	// where they will see it — the UI really does start with no authentication.
	config := RenderProwlarrConfig(ProwlarrSettings{APIKey: "k", Port: 9696, PublishUI: true})
	if !strings.Contains(config, "NO\n  authentication") {
		t.Errorf("a published UI should carry the warning:\n%s", config)
	}
	if !strings.Contains(config, "Settings -> General ->") {
		t.Error("it should say where to fix it")
	}

	quiet := RenderProwlarrConfig(ProwlarrSettings{APIKey: "k", Port: 9696, PublishUI: false})
	if strings.Contains(quiet, "NO\n  authentication") {
		t.Error("an internal-only Prowlarr needs no such warning")
	}
}
