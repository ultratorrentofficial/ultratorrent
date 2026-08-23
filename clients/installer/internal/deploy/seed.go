package deploy

import (
	"context"
	"fmt"
	"strings"
)

// BackendService is the Compose service that owns the database.
const BackendService = "backend"

// seedCommand runs the backend's own seed script inside its container.
//
// The image carries prisma/ and an unpruned node_modules, so ts-node is there;
// this is the same command an operator would run by hand.
const seedCommand = "cd /app/apps/backend && npm run prisma:seed"

// Seed creates the first administrator and the role and permission rows.
//
// Why the deployment does this rather than leaving it to the operator: the
// backend's CMD runs `prisma migrate deploy` and nothing else, so a new
// installation comes up with a complete schema and an EMPTY users table. Every
// container passes its healthcheck, `up --wait` succeeds, and the sign-in page
// rejects every password there is. The stack was reported healthy and was not
// usable, which made "all services healthy" a false summary of the outcome.
//
// Safe on every deployment, not just the first: seed.ts is written with upsert,
// so re-running it neither duplicates the administrator nor resets a password
// that has since been changed. That is what lets this run unconditionally
// instead of the installer having to guess whether an installation is new.
//
// The output is RETURNED, never printed by the caller on success: the script
// ends by printing the administrator's password, which the installer has
// already written to a file that only root can read. Putting it on a terminal
// would undo that.
func (c *Compose) Seed(ctx context.Context) (string, error) {
	args, err := c.baseArgs()
	if err != nil {
		return "", err
	}
	// -T because the installer's runner gives the child no stdin; without it
	// Compose tries to allocate a TTY and fails where there is none, which is
	// every unattended install.
	stdout, stderr, err := c.Run(ctx, "docker", c.composeEnv(),
		append(args, "exec", "-T", BackendService, "sh", "-c", seedCommand)...)
	if err != nil {
		return stdout + stderr, fmt.Errorf("seeding the database: %s", firstLine(stderr))
	}
	return stdout, nil
}

// loginProbe asks the backend whether the seeded administrator can sign in.
//
// Run INSIDE the backend container, which already holds ADMIN_USERNAME and
// ADMIN_PASSWORD in its environment — the same values seed.ts reads. Nothing
// secret is passed as an argument, so no password reaches the host's process
// list, and the probe prints only a status code and whether a token came back.
const loginProbe = `
const u = process.env.ADMIN_USERNAME || 'admin';
const p = process.env.ADMIN_PASSWORD || '';
if (!p) { console.log('SKIP no-admin-password-in-environment'); process.exit(0); }
fetch('http://127.0.0.1:4000/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }),
}).then(async (r) => {
  let token = false;
  try { const j = await r.json(); token = Boolean(j.accessToken || j.access_token); } catch {}
  console.log(r.status + ' ' + (token ? 'TOKEN' : 'NOTOKEN'));
}).catch((e) => console.log('ERR ' + e.message));
`

// SignInWorks reports whether the administrator can actually authenticate.
//
// The check that makes "healthy" mean something. A healthcheck says a process
// is answering; this says the product can be used. Three answers, deliberately
// distinct: it worked, it did not, or the question could not be asked — and the
// third is never reported as the first.
func (c *Compose) SignInWorks(ctx context.Context) (ok bool, detail string, known bool) {
	args, err := c.baseArgs()
	if err != nil {
		return false, err.Error(), false
	}
	stdout, _, err := c.Run(ctx, "docker", c.composeEnv(),
		append(args, "exec", "-T", BackendService, "node", "-e", loginProbe)...)
	if err != nil {
		return false, "the sign-in check could not be run", false
	}
	answer := strings.TrimSpace(lastSubstantive(stdout))
	switch {
	case strings.HasSuffix(answer, " TOKEN"):
		return true, answer, true
	case strings.HasPrefix(answer, "SKIP"), answer == "":
		return false, answer, false
	default:
		return false, answer, true
	}
}

// lastSubstantive returns the final non-blank line.
//
// Node prints warnings before the program's own output — the seed script draws
// two about module types — so the answer is at the END, not the beginning.
func lastSubstantive(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}
