package deploy

import (
	"context"
	"fmt"
	"strings"
)

// WireOptions describes the integration to set up after a deployment.
type WireOptions struct {
	ProwlarrAPIKey  string
	ProwlarrURL     string // as the backend reaches it, e.g. http://prowlarr:9696
	FlareSolverrURL string // empty when FlareSolverr is not deployed
}

// wireScript connects Prowlarr to UltraTorrent, and FlareSolverr to Prowlarr.
//
// Run INSIDE the backend container, because that is the only place both ends
// are reachable: Prowlarr is on the internal network and deliberately not
// published by default, and the backend's API answers on its own loopback. It
// also already holds ADMIN_USERNAME and ADMIN_PASSWORD, so no credential is
// passed as an argument.
//
// Everything it does is idempotent. Re-running an installer is ordinary — it is
// how a companion gets added later — so each step asks what already exists
// before creating anything, and an installation that is already wired comes out
// of this unchanged rather than with a second FlareSolverr proxy.
const wireScript = `
const key = process.env.UT_PROWLARR_KEY || '';
const prowlarr = process.env.UT_PROWLARR_URL || 'http://prowlarr:9696';
const flare = process.env.UT_FLARESOLVERR_URL || '';
const api = 'http://127.0.0.1:4000/api';
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || '';
const notes = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pj(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: r.status, body, text };
}

async function prowlarrReady() {
  // Prowlarr builds its database on first start; asking too early gets a
  // connection refused rather than an error worth reporting.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await pj(prowlarr + '/api/v1/system/status', { headers: { 'X-Api-Key': key } });
      if (r.status === 200) return true;
      if (r.status === 401) { notes.push('prowlarr-rejected-key'); return false; }
    } catch {}
    await sleep(2000);
  }
  notes.push('prowlarr-not-ready');
  return false;
}

async function ensureFlareSolverr() {
  if (!flare) return 'flaresolverr:not-deployed';
  const hdr = { 'X-Api-Key': key, 'Content-Type': 'application/json' };

  const existing = await pj(prowlarr + '/api/v1/indexerproxy', { headers: hdr });
  if (Array.isArray(existing.body) &&
      existing.body.some((p) => (p.implementation || '') === 'FlareSolverr')) {
    return 'flaresolverr:already-configured';
  }

  // Prowlarr applies a proxy to the indexers carrying its tag, so the tag is
  // the part the operator uses later: add an indexer, tag it, and it goes
  // through FlareSolverr.
  let tagId = null;
  const tags = await pj(prowlarr + '/api/v1/tag', { headers: hdr });
  if (Array.isArray(tags.body)) {
    const found = tags.body.find((t) => t.label === 'flaresolverr');
    if (found) tagId = found.id;
  }
  if (tagId === null) {
    const made = await pj(prowlarr + '/api/v1/tag', {
      method: 'POST', headers: hdr, body: JSON.stringify({ label: 'flaresolverr' }),
    });
    if (!made.body || !made.body.id) return 'flaresolverr:tag-failed';
    tagId = made.body.id;
  }

  const created = await pj(prowlarr + '/api/v1/indexerproxy', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({
      name: 'FlareSolverr',
      implementation: 'FlareSolverr',
      configContract: 'FlareSolverrSettings',
      tags: [tagId],
      fields: [
        { name: 'host', value: flare },
        { name: 'requestTimeout', value: 60 },
      ],
    }),
  });
  if (created.status >= 200 && created.status < 300) return 'flaresolverr:configured';
  return 'flaresolverr:failed-' + created.status;
}

async function registerWithUltraTorrent() {
  if (!pass) return 'integration:no-admin-password';
  const login = await pj(api + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const token = login.body && (login.body.accessToken || login.body.access_token);
  if (!token) return 'integration:sign-in-failed-' + login.status;

  const hdr = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const saved = await pj(api + '/integrations/prowlarr', {
    method: 'PATCH', headers: hdr,
    body: JSON.stringify({ enabled: true, internalUrl: prowlarr, apiKey: key }),
  });
  if (saved.status < 200 || saved.status >= 300) return 'integration:save-failed-' + saved.status;

  const tested = await pj(api + '/integrations/prowlarr/test', {
    method: 'POST', headers: hdr, body: '{}',
  });
  if (tested.status >= 200 && tested.status < 300) return 'integration:connected';
  return 'integration:saved-but-test-failed-' + tested.status;
}

(async () => {
  if (!key) { console.log('RESULT no-api-key'); return; }
  if (!(await prowlarrReady())) { console.log('RESULT ' + (notes[0] || 'prowlarr-unreachable')); return; }
  const a = await ensureFlareSolverr();
  const b = await registerWithUltraTorrent();
  console.log('RESULT ' + a + ' ' + b);
})().catch((e) => console.log('RESULT error ' + (e && e.message ? e.message : e)));
`

// WireProwlarr sets the integration up so the operator does not have to.
//
// The whole point of this installer is that someone who does not want to read
// documentation ends up with a working system, and "now open Settings and paste
// this key" is exactly the step that loses people. Failures here are reported
// and do NOT fail the deployment: the stack is running and usable, and an
// unwired indexer manager is something to finish by hand, not a reason to tear
// a working installation down.
func (c *Compose) WireProwlarr(ctx context.Context, o WireOptions) (string, error) {
	args, err := c.baseArgs()
	if err != nil {
		return "", err
	}
	exec := append(args, "exec", "-T",
		"-e", "UT_PROWLARR_KEY="+o.ProwlarrAPIKey,
		"-e", "UT_PROWLARR_URL="+o.ProwlarrURL,
		"-e", "UT_FLARESOLVERR_URL="+o.FlareSolverrURL,
		BackendService, "node", "-e", wireScript)

	stdout, stderr, err := c.Run(ctx, "docker", c.composeEnv(), exec...)
	if err != nil {
		return "", fmt.Errorf("wiring Prowlarr: %s", firstLine(stderr))
	}
	for _, line := range strings.Split(stdout, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "RESULT ") {
			return strings.TrimPrefix(line, "RESULT "), nil
		}
	}
	return "", fmt.Errorf("the wiring step said nothing")
}

// Where the companions answer inside the Compose network.
const (
	ProwlarrContainerPort = 9696
	// Trailing slash: Prowlarr's own field default carries one, and its
	// FlareSolverr client builds request URLs by appending to this value.
	FlareSolverrInternalURL = "http://flaresolverr:8191/"
)

// ExplainWiring turns one machine-readable outcome into a line for a person.
//
// The outcomes are deliberately terse across the container boundary and
// deliberately plain here: someone reading an installer's output wants to know
// whether they still have work to do.
func ExplainWiring(outcome string) string {
	switch {
	case outcome == "flaresolverr:configured":
		return "FlareSolverr added to Prowlarr — tag an indexer `flaresolverr` to route it through"
	case outcome == "flaresolverr:already-configured":
		return "FlareSolverr was already set up in Prowlarr"
	case outcome == "flaresolverr:not-deployed":
		return ""
	case outcome == "integration:connected":
		return "Prowlarr connected to UltraTorrent and answering"
	case outcome == "integration:no-admin-password":
		return "Prowlarr could not be connected: no administrator password was available"
	case strings.HasPrefix(outcome, "integration:saved-but-test-failed"):
		return "Prowlarr was connected but did not answer a test — check it under Settings -> Integrations"
	case strings.HasPrefix(outcome, "integration:sign-in-failed"):
		return "Prowlarr could not be connected: signing in to UltraTorrent failed"
	case strings.HasPrefix(outcome, "integration:save-failed"):
		return "Prowlarr could not be saved into UltraTorrent — add it under Settings -> Integrations"
	case strings.HasPrefix(outcome, "flaresolverr:"):
		return "FlareSolverr could not be added to Prowlarr (" + outcome + ") — add it in Prowlarr under Settings -> Indexer Proxies"
	case outcome == "prowlarr-rejected-key":
		return "Prowlarr rejected the API key the installer holds — connect it under Settings -> Integrations"
	case outcome == "prowlarr-not-ready", outcome == "prowlarr-unreachable":
		return "Prowlarr did not answer in time — connect it under Settings -> Integrations"
	case outcome == "no-api-key":
		return "Prowlarr's API key is unknown — connect it under Settings -> Integrations"
	}
	return "Prowlarr setup: " + outcome
}
