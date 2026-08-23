package proxy

import (
	"strings"
	"testing"
)

func TestSiteAddressDecidesWhetherCaddyChasesACertificate(t *testing.T) {
	/*
	 * The distinction matters more than it looks. A bare `:80` means Caddy does
	 * not attempt ACME at all, which is right for an IP or localhost — no
	 * certificate authority will issue for either, and Caddy retrying a hopeless
	 * challenge is a startup that never settles.
	 */
	cases := []struct {
		publicURL string
		address   string
		https     bool
	}{
		{"", ":80", false},
		{"https://media.example.com", "media.example.com", true},
		{"https://media.example.com:8443", "media.example.com", true},
		{"http://media.example.com", "http://media.example.com", false},
		{"http://192.168.1.10:8080", ":80", false},
		{"https://10.0.0.5", ":80", false},
		{"http://localhost:8080", ":80", false},
		{"not a url at all", ":80", false},
	}
	for _, c := range cases {
		address, https := SiteAddress(c.publicURL)
		if address != c.address || https != c.https {
			t.Errorf("SiteAddress(%q) = (%q, %v), want (%q, %v)",
				c.publicURL, address, https, c.address, c.https)
		}
	}
}

func TestRoutingMirrorsTheRepositorysOwnCaddyfile(t *testing.T) {
	// The /api and /ws split belongs to the application, not the proxy.
	// Inventing a different one would make the bundled proxy behave unlike the
	// documented one.
	config := RenderCaddyfile(Settings{PublicURL: "https://media.example.com"})
	for _, want := range []string{
		"@api path /api/* /ws/*",
		"reverse_proxy backend:4000",
		"reverse_proxy frontend:8080",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("missing %q in:\n%s", want, config)
		}
	}
}

func TestAnAutomaticCertificateStatesItsPreconditions(t *testing.T) {
	// A first start that keeps retrying an ACME challenge looks like a hang. The
	// two things that cause it are worth saying up front.
	config := RenderCaddyfile(Settings{PublicURL: "https://media.example.com"})
	if !strings.Contains(config, "port 80 reachable") || !strings.Contains(config, "resolving to this host") {
		t.Errorf("the preconditions should be stated:\n%s", config)
	}

	plain := RenderCaddyfile(Settings{PublicURL: "http://192.168.1.10"})
	if strings.Contains(plain, "obtain and renew") {
		t.Error("an IP address gets no certificate; it must not claim otherwise")
	}
	if !strings.Contains(plain, "no certificate authority will issue") {
		t.Errorf("it should say why it is plain HTTP:\n%s", plain)
	}
}
