package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Skipping a build risks deploying a stale image while reporting success, which
// is worse than the minutes a rebuild costs. So every case here asks the same
// question: does this uncertainty resolve towards building?

const headSha = "873878b1c4446193ac21ea2a2a613871b1134eb1"

type sourceState struct {
	head       string
	headErr    bool
	dirty      string
	backendSha string
	noBackend  bool
	noFrontend bool
}

func (st sourceState) compose() *Compose {
	return &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Run: func(_ context.Context, name string, _ []string, args ...string) (string, string, error) {
			joined := strings.Join(args, " ")
			switch {
			case name == "git" && strings.Contains(joined, "rev-parse"):
				if st.headErr {
					return "", "not a git repository", errors.New("exit 128")
				}
				return st.head + "\n", "", nil
			case name == "git" && strings.Contains(joined, "status"):
				return st.dirty, "", nil
			case strings.Contains(joined, "image inspect"):
				if strings.Contains(joined, "-backend") {
					if st.noBackend {
						return "", "No such image", errors.New("exit 1")
					}
					return "PATH=/usr/bin\nGIT_SHA=" + st.backendSha + "\n", "", nil
				}
				if st.noFrontend {
					return "", "No such image", errors.New("exit 1")
				}
				return "PATH=/usr/bin\n", "", nil
			}
			return "", "", nil
		},
	}
}

func TestAMatchingCommitOnACleanTreeSkipsTheBuild(t *testing.T) {
	current, reason := sourceState{head: headSha, backendSha: headSha}.compose().
		ImagesAreCurrent(context.Background())
	if !current {
		t.Fatalf("rebuilt identical source: %s", reason)
	}
}

func TestEveryUncertaintyBuilds(t *testing.T) {
	cases := map[string]sourceState{
		// The one that matters most: someone testing an uncommitted change.
		// The commit cannot see their edit, so skipping deploys the old code.
		"uncommitted changes":    {head: headSha, backendSha: headSha, dirty: " M apps/backend/src/main.ts\n"},
		"a different commit":     {head: headSha, backendSha: "0000000000000000000000000000000000000000"},
		"not a git checkout":     {headErr: true, backendSha: headSha},
		"empty HEAD":             {head: "", backendSha: headSha},
		"no backend image":       {head: headSha, noBackend: true},
		"backend records no sha": {head: headSha, backendSha: ""},
		// The frontend carries no stamp, so existence is all there is to check.
		"frontend image missing": {head: headSha, backendSha: headSha, noFrontend: true},
	}
	for name, st := range cases {
		current, reason := st.compose().ImagesAreCurrent(context.Background())
		if current {
			t.Errorf("%s: skipped the build anyway", name)
		}
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s: skipped nothing but explained nothing either", name)
		}
	}
}

// The image name has to be the one Compose actually builds, or the check reads
// nothing and every deployment rebuilds forever.
func TestTheImageNameMatchesWhatComposeBuilds(t *testing.T) {
	c := &Compose{ProjectName: "UltraTorrent"}
	if got := c.imageName("backend"); got != "ultratorrent-backend:latest" {
		t.Errorf("image name %q does not match Compose's own", got)
	}
}
