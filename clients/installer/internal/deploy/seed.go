package deploy

import (
	"context"
	"fmt"
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
