package plan

import "testing"

// An empty ProjectName means "let Compose derive it from the directory", which
// is how an installation attaches itself to a stack it did not create — run
// from a checkout beside an existing deployment and Compose reconfigures that
// one. deploy refuses an empty name; this asserts the default path never
// produces one, so the refusal stays unreachable.
func TestRecommendedAlwaysSetsAProjectName(t *testing.T) {
	for _, target := range []TargetOS{TargetLinux, TargetWindows} {
		p := RecommendedFor("test", target)
		if p.ProjectName == "" {
			t.Fatalf("%s: ProjectName is empty; Compose would derive it from the directory", target)
		}
		if p.ProjectName != DefaultProjectName {
			t.Errorf("%s: ProjectName = %q, want %q", target, p.ProjectName, DefaultProjectName)
		}
	}
}
