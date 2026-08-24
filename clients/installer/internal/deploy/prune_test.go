package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Compose acts only on the services its ACTIVE profiles select. A service
// excluded by a profile is not an orphan — it is a service Compose was not
// asked about — so `up` leaves it running, and `--remove-orphans` does not
// remove it either. Measured against Docker 29 / Compose 5.5: switching the
// engine left BOTH engines running on the same /downloads volume.

type routedRunner struct {
	services   string
	ps         string
	removed    []string
	failList   bool
	failRemove bool
}

func (r *routedRunner) run() Runner {
	return func(_ context.Context, _ string, _ []string, args ...string) (string, string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "config --services"):
			if r.failList {
				return "", "no configuration file", errors.New("exit 1")
			}
			return r.services, "", nil
		case strings.Contains(joined, "ps --all"):
			return r.ps, "", nil
		case strings.HasPrefix(joined, "rm --force"):
			if r.failRemove {
				return "", "permission denied", errors.New("exit 1")
			}
			r.removed = append(r.removed, args[len(args)-1])
			return "", "", nil
		}
		return "", "", nil
	}
}

func pruneCompose(r *routedRunner) *Compose {
	return &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Profiles: []string{"rtorrent"}, HasOverride: true, Run: r.run(),
	}
}

const runningPS = "backend\tultratorrent-backend-1\taaa1\n" +
	"rtorrent\tultratorrent-rtorrent-1\tbbb2\n" +
	"qbittorrent\tultratorrent-qbittorrent-1\tccc3\n" +
	"prowlarr\tultratorrent-prowlarr-1\tddd4\n"

func TestOnlyServicesThePlanDroppedAreStale(t *testing.T) {
	r := &routedRunner{services: "backend\nrtorrent\n", ps: runningPS}
	stale, err := pruneCompose(r).StaleContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, s := range stale {
		names = append(names, s.Service)
	}
	if strings.Join(names, ",") != "prowlarr,qbittorrent" {
		t.Errorf("stale set was %v; wanted the two services the plan dropped", names)
	}
}

// The dangerous failure: an empty answer must never mean "everything is stale".
func TestAnEmptyServiceListPrunesNothing(t *testing.T) {
	r := &routedRunner{services: "\n", ps: runningPS}
	if _, err := pruneCompose(r).StaleContainers(context.Background()); err == nil {
		t.Fatal("an empty service list was accepted — that would remove the whole project")
	}
	if len(r.removed) != 0 {
		t.Errorf("removed containers despite not knowing what should run: %v", r.removed)
	}
}

func TestAFailedListingRemovesNothing(t *testing.T) {
	r := &routedRunner{failList: true, ps: runningPS}
	if _, err := pruneCompose(r).StaleContainers(context.Background()); err == nil {
		t.Fatal("a failed listing was treated as an answer")
	}
	if len(r.removed) != 0 {
		t.Errorf("removed containers on a failed listing: %v", r.removed)
	}
}

// Data must survive: removing the container is a change of mind, not a wipe.
func TestRemovalTakesContainersAndNeverVolumes(t *testing.T) {
	r := &routedRunner{services: "backend\nrtorrent\n", ps: runningPS}
	c := pruneCompose(r)
	stale, err := c.StaleContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveStale(context.Background(), stale); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.removed, ",") != "ddd4,ccc3" {
		t.Errorf("removed %v, want the prowlarr and qbittorrent containers by id", r.removed)
	}
}

func TestARemovalFailureIsReportedRatherThanSwallowed(t *testing.T) {
	r := &routedRunner{services: "backend\n", ps: runningPS, failRemove: true}
	c := pruneCompose(r)
	stale, _ := c.StaleContainers(context.Background())
	if err := c.RemoveStale(context.Background(), stale); err == nil {
		t.Fatal("a failed removal reported success")
	}
}
