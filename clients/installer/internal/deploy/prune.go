package deploy

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Stale is a container running for a service the plan no longer deploys.
type Stale struct {
	Service   string
	Container string
	ID        string
}

// DesiredServices asks Compose which services the active profiles deploy.
//
// Asked rather than derived: the profile rules live in the Compose file, and a
// second copy of them here would be one to drift.
func (c *Compose) DesiredServices(ctx context.Context) (map[string]bool, error) {
	args, err := c.baseArgs()
	if err != nil {
		return nil, err
	}
	stdout, stderr, err := c.Run(ctx, "docker", c.composeEnv(),
		append(args, "config", "--services")...)
	if err != nil {
		return nil, fmt.Errorf("listing the services this plan deploys: %s", firstLine(stderr))
	}
	desired := map[string]bool{}
	for _, line := range strings.Split(stdout, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			desired[name] = true
		}
	}
	if len(desired) == 0 {
		// Never prune on an empty answer: it would mean removing every container
		// in the project because a command returned nothing useful.
		return nil, fmt.Errorf("Compose named no services for this plan")
	}
	return desired, nil
}

// StaleContainers finds containers this project is running for services the
// plan no longer includes.
//
// The case this exists for: changing the engine. Compose only ever acts on the
// services its ACTIVE profiles select, and a service excluded by a profile is
// not an orphan — it is a service Compose was not asked about — so `up` leaves
// it running and `--remove-orphans` does not touch it either (measured, not
// assumed). Switching from qBittorrent to rTorrent therefore left BOTH engines
// running against the same /downloads volume, and turning a companion off left
// it up indefinitely.
func (c *Compose) StaleContainers(ctx context.Context) ([]Stale, error) {
	desired, err := c.DesiredServices(ctx)
	if err != nil {
		return nil, err
	}
	stdout, stderr, err := c.Run(ctx, "docker", nil,
		"ps", "--all", "--filter", "label=com.docker.compose.project="+c.ProjectName,
		"--format", `{{.Label "com.docker.compose.service"}}	{{.Names}}	{{.ID}}`)
	if err != nil {
		return nil, fmt.Errorf("listing this project's containers: %s", firstLine(stderr))
	}
	var stale []Stale
	for _, line := range strings.Split(stdout, "\n") {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) != 3 || fields[0] == "" {
			continue
		}
		if desired[fields[0]] {
			continue
		}
		stale = append(stale, Stale{Service: fields[0], Container: fields[1], ID: fields[2]})
	}
	sort.Slice(stale, func(i, j int) bool { return stale[i].Service < stale[j].Service })
	return stale, nil
}

// RemoveStale removes those containers, keeping their data.
//
// `docker rm --force` and deliberately nothing more: it takes the container and
// leaves every named volume alone, so an engine switched away from keeps its
// configuration and its torrents, and switching back finds them. Removing
// volumes here would turn a change of mind into data loss.
//
// Filtered by this project's label before anything is removed — twice over,
// since StaleContainers already asked Docker to filter — because the blast
// radius of getting this wrong is somebody else's container.
func (c *Compose) RemoveStale(ctx context.Context, stale []Stale) error {
	for _, s := range stale {
		if s.ID == "" {
			continue
		}
		if _, stderr, err := c.Run(ctx, "docker", nil, "rm", "--force", s.ID); err != nil {
			return fmt.Errorf("removing %s: %s", s.Container, firstLine(stderr))
		}
	}
	return nil
}
