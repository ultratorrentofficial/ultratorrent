//go:build unix

package storage

import (
	"strings"
	"syscall"
	"testing"

	"github.com/ultratorrent/installer/internal/host"
)

// The ownership half of the storage tests, which only Unix can answer.
//
// Split out rather than tagged away wholesale: everything else in this
// package's tests — path mapping, creation order, the missing-directory rules —
// is platform-neutral and must keep running everywhere. Only the ownership
// question depends on a `*syscall.Stat_t`, and on Windows `statOwner` reports
// "unknown" by design, so asserting a finding there would be asserting the
// stub.

// Sys returns a real *syscall.Stat_t so the ownership check is genuinely
// exercised rather than skipped because the platform could not answer.
func (i fakeInfo) Sys() any {
	return &syscall.Stat_t{Uid: uint32(i.file.uid), Gid: uint32(i.file.gid)}
}

func TestExistingOwnershipMismatchIsReportedNotFixed(t *testing.T) {
	// Reported so the operator can act, with the command spelled out — but the
	// decision stays theirs.
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	fake.addDir("/srv/media", 1000, 1000)
	dirs := Plan(bindPlan())
	dirs[0].Owner = &Ownership{UID: 997, GID: 997}

	var warned bool
	for _, f := range Inspect(dirs, "/opt/ultratorrent", fake.ops()) {
		if f.Level == host.LevelFail {
			t.Fatalf("an ownership question must never be fatal: %+v", f)
		}
		if f.Value == "/srv/media" && f.Level == host.LevelWarn {
			warned = true
			if !strings.Contains(f.Remedy, "chown -R 997:997 /srv/media") {
				t.Errorf("the remedy should spell out the command: %q", f.Remedy)
			}
			if !strings.Contains(f.Detail, "1000:1000") {
				t.Errorf("it should say what the tree is owned by now: %q", f.Detail)
			}
		}
	}
	if !warned {
		t.Error("a tree owned by someone else should be reported")
	}

	// And matching ownership must stay quiet.
	dirs[0].Owner = &Ownership{UID: 1000, GID: 1000}
	for _, f := range Inspect(dirs, "/opt/ultratorrent", fake.ops()) {
		if f.Value == "/srv/media" && f.Level != host.LevelOK {
			t.Errorf("matching ownership should not be reported: %+v", f)
		}
	}
}
