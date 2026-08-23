package storage

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ultratorrent/installer/internal/host"
	"github.com/ultratorrent/installer/internal/plan"
)

func bindPlan() *plan.Plan {
	p := plan.Recommended("v1.0.0-test")
	p.InstallDirectory = "/opt/ultratorrent"
	p.Storage.Mode = plan.StorageBind
	p.Storage.MediaRoot = "/srv/media"
	p.Finalize()
	return p
}

// --- layout ----------------------------------------------------------------

func TestNamedVolumeNeedsNothingPrepared(t *testing.T) {
	// Docker owns the storage; inventing a host path would create a directory
	// nothing ever mounts.
	p := plan.Recommended("v1.0.0-test")
	p.Storage.Mode = plan.StorageVolume
	p.Finalize()
	if dirs := Plan(p); len(dirs) != 0 {
		t.Errorf("a named volume should need no host directories, got %v", dirs)
	}
	if _, ok := HostPath(p, "/downloads/tv"); ok {
		t.Error("there is no host path for a named volume")
	}
}

func TestContainerPathsResolveToTheHost(t *testing.T) {
	p := bindPlan()
	cases := map[string]string{
		"/downloads":            "/srv/media",
		"/downloads/":           "/srv/media",
		"/downloads/tv":         "/srv/media/tv",
		"/downloads/tv/../film": "/srv/media/film",
	}
	for containerPath, want := range cases {
		got, ok := HostPath(p, containerPath)
		if !ok {
			t.Errorf("HostPath(%q) reported no mapping", containerPath)
			continue
		}
		if got != want {
			t.Errorf("HostPath(%q) = %q, want %q", containerPath, got, want)
		}
	}
}

func TestPathsOutsideTheSharedTreeHaveNoHostMapping(t *testing.T) {
	/*
	 * Only /downloads is bound. Returning a plausible path for anything else
	 * would be worse than refusing: a caller would create a directory that no
	 * container ever sees, and the operator would find an empty folder where
	 * their media was supposed to be.
	 */
	p := bindPlan()
	for _, containerPath := range []string{"/config", "/downloadsomething", "/", "/var/downloads"} {
		if got, ok := HostPath(p, containerPath); ok {
			t.Errorf("HostPath(%q) = %q, want no mapping", containerPath, got)
		}
	}
}

func TestHostPathsMapBackIntoTheContainer(t *testing.T) {
	// The reverse direction is for diagnostics: an operator reads a path off
	// their own filesystem and needs to know what UltraTorrent calls it.
	p := bindPlan()
	if got, ok := ContainerPathFor(p, "/srv/media/tv/show"); !ok || got != "/downloads/tv/show" {
		t.Errorf("ContainerPathFor = %q, %v", got, ok)
	}
	if got, ok := ContainerPathFor(p, "/srv/media"); !ok || got != "/downloads" {
		t.Errorf("root should map to %q, got %q", ContainerRoot, got)
	}
	// Outside the tree, and — importantly — a sibling with a shared prefix.
	for _, outside := range []string{"/srv/other", "/srv", "/srv/media-backup"} {
		if got, ok := ContainerPathFor(p, outside); ok {
			t.Errorf("ContainerPathFor(%q) = %q, want no mapping", outside, got)
		}
	}
}

func TestLibrariesAndStagingBecomeDirectories(t *testing.T) {
	p := bindPlan()
	p.Intake.Enabled = true
	p.Intake.StagingPath = "/downloads/staging"
	p.Intake.ProfileName = "Default"
	p.Storage.Libraries = []plan.Library{
		{Name: "Films", Kind: "movie", Path: "/downloads/movies"},
		{Name: "TV", Kind: "tv", Path: "/downloads/tv"},
	}
	p.Finalize()

	paths := map[string]bool{}
	for _, d := range Plan(p) {
		paths[d.Path] = true
	}
	for _, want := range []string{"/srv/media", "/srv/media/staging", "/srv/media/movies", "/srv/media/tv"} {
		if !paths[want] {
			t.Errorf("%s was not planned; got %v", want, paths)
		}
	}
}

func TestOnlyTheMediaRootIsRequired(t *testing.T) {
	/*
	 * The distinction is real. Without the media root the container cannot start
	 * at all — a bind device that does not exist is a mount failure, confirmed
	 * against Docker. A missing library subdirectory is merely untidy; the engine
	 * creates its own save paths.
	 */
	p := bindPlan()
	p.Storage.Libraries = []plan.Library{{Name: "TV", Kind: "tv", Path: "/downloads/tv"}}
	p.Finalize()
	for _, d := range Plan(p) {
		if d.Path == "/srv/media" && !d.Required {
			t.Error("the media root is required — it is the bind device")
		}
		if d.Path == "/srv/media/tv" && d.Required {
			t.Error("a library subdirectory should not block the install")
		}
	}
}

func TestParentsAreCreatedBeforeChildren(t *testing.T) {
	// So each is reported on its own line; a single MkdirAll could only report
	// the deepest one.
	p := bindPlan()
	p.Storage.Libraries = []plan.Library{{Name: "Deep", Kind: "tv", Path: "/downloads/a/b/c"}}
	p.Finalize()
	dirs := Plan(p)
	for i := 1; i < len(dirs); i++ {
		if len(dirs[i].Path) < len(dirs[i-1].Path) &&
			filepath.HasPrefix(dirs[i-1].Path, dirs[i].Path) {
			t.Errorf("child %s came before parent %s", dirs[i-1].Path, dirs[i].Path)
		}
	}
}

func TestDuplicatePathsAreCollapsed(t *testing.T) {
	// Two libraries can legitimately name the same directory.
	p := bindPlan()
	p.Storage.Libraries = []plan.Library{
		{Name: "One", Kind: "tv", Path: "/downloads/shared"},
		{Name: "Two", Kind: "movie", Path: "/downloads/shared"},
	}
	p.Finalize()
	count := 0
	for _, d := range Plan(p) {
		if d.Path == "/srv/media/shared" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("planned the same directory %d times", count)
	}
}

// --- a fake filesystem -----------------------------------------------------

type fakeFile struct {
	dir  bool
	uid  int
	gid  int
	fail error
}

type fakeFS struct {
	files    map[string]*fakeFile
	devices  map[string]uint64
	created  []string
	chowned  map[string]string
	modes    map[string]fs.FileMode
	failMake error
}

func newFakeFS() *fakeFS {
	return &fakeFS{files: map[string]*fakeFile{}, devices: map[string]uint64{},
		chowned: map[string]string{}, modes: map[string]fs.FileMode{}}
}

func (f *fakeFS) addDir(path string, uid, gid int) {
	f.files[path] = &fakeFile{dir: true, uid: uid, gid: gid}
}

func (f *fakeFS) ops() Ops {
	return Ops{
		Stat: func(p string) (os.FileInfo, error) {
			if file, ok := f.files[p]; ok {
				return fakeInfo{name: filepath.Base(p), file: file}, nil
			}
			// A parent that is a file makes every descendant ENOTDIR, as the real
			// kernel does.
			for parent := filepath.Dir(p); parent != "/" && parent != "."; parent = filepath.Dir(parent) {
				if file, ok := f.files[parent]; ok && !file.dir {
					return nil, &os.PathError{Op: "stat", Path: p, Err: syscall.ENOTDIR}
				}
			}
			return nil, &os.PathError{Op: "stat", Path: p, Err: os.ErrNotExist}
		},
		MkdirAll: func(p string, _ fs.FileMode) error {
			if f.failMake != nil {
				return f.failMake
			}
			f.created = append(f.created, p)
			f.addDir(p, 0, 0)
			return nil
		},
		Chmod: func(p string, mode fs.FileMode) error {
			f.modes[p] = mode
			return nil
		},
		Chown: func(p string, uid, gid int) error {
			f.chowned[p] = string(rune('0'+uid)) + ":" + string(rune('0'+gid))
			return nil
		},
		WriteProbe: func(p string) error {
			if file, ok := f.files[p]; ok && file.fail != nil {
				return file.fail
			}
			return nil
		},
		DeviceID: func(p string) (uint64, bool) {
			d, ok := f.devices[p]
			return d, ok
		},
	}
}

type fakeInfo struct {
	name string
	file *fakeFile
}

func (i fakeInfo) Name() string       { return i.name }
func (i fakeInfo) Size() int64        { return 0 }
func (i fakeInfo) Mode() fs.FileMode  { return 0o755 }
func (i fakeInfo) ModTime() time.Time { return time.Time{} }
func (i fakeInfo) IsDir() bool        { return i.file.dir }

// --- inspection ------------------------------------------------------------

func levelFor(findings []host.Finding, path string) host.Level {
	for _, f := range findings {
		if f.Value == path {
			return f.Level
		}
	}
	return ""
}

func TestAMissingDirectoryIsAnActionNotAFailure(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	dirs := Plan(bindPlan())
	findings := Inspect(dirs, "/opt/ultratorrent", fake.ops())
	if got := levelFor(findings, "/srv/media"); got != host.LevelAction {
		t.Errorf("level = %q, want %q — it can simply be created", got, host.LevelAction)
	}
	if Blocked(findings) {
		t.Error("a creatable directory must not block the installation")
	}
}

func TestAnUnwritableParentBlocks(t *testing.T) {
	// Better to say so now than to fail partway through creating the layout.
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	fake.files["/srv"].fail = errors.New("read-only file system")
	findings := Inspect(Plan(bindPlan()), "/opt/ultratorrent", fake.ops())
	if !Blocked(findings) {
		t.Error("an unwritable parent must block")
	}
}

func TestAPathThatIsAFileBlocks(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	fake.files["/srv/media"] = &fakeFile{dir: false}
	findings := Inspect(Plan(bindPlan()), "/opt/ultratorrent", fake.ops())
	if !Blocked(findings) {
		t.Fatal("a file where a directory belongs must block")
	}
	// And a descendant must not report a raw ENOTDIR naming the leaf, which sends
	// the operator looking in the wrong place.
	for _, f := range findings {
		if f.Value == "/srv/media/incomplete" && !strings.Contains(f.Detail, "a parent of this path is a file") {
			t.Errorf("unhelpful detail for a descendant: %q", f.Detail)
		}
	}
}

func TestMediaRootOnTheSameFilesystemWarns(t *testing.T) {
	/*
	 * The mistake that costs most to discover late: the array or NAS share is
	 * not mounted, so the path is an empty directory on the root disk. Nothing
	 * fails — the stack comes up and works — until the root filesystem fills with
	 * media that then has to be moved off it across a device boundary.
	 */
	fake := newFakeFS()
	fake.addDir("/srv/media", 0, 0)
	fake.addDir("/opt/ultratorrent", 0, 0)
	fake.devices["/srv/media"] = 64
	fake.devices["/opt/ultratorrent"] = 64 // same device

	findings := Inspect(Plan(bindPlan()), "/opt/ultratorrent", fake.ops())
	var warned bool
	for _, f := range findings {
		if f.Level == host.LevelWarn && strings.Contains(f.Detail, "not mounted") {
			warned = true
		}
	}
	if !warned {
		t.Error("an unmounted media root should warn")
	}
	if Blocked(findings) {
		t.Error("it must never block — a single-disk host is a legitimate setup")
	}
}

func TestSeparateFilesystemDoesNotWarn(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv/media", 0, 0)
	fake.addDir("/opt/ultratorrent", 0, 0)
	fake.devices["/srv/media"] = 99
	fake.devices["/opt/ultratorrent"] = 64

	for _, f := range Inspect(Plan(bindPlan()), "/opt/ultratorrent", fake.ops()) {
		if strings.Contains(f.Detail, "not mounted") {
			t.Error("a media root on its own device must not warn")
		}
	}
}

// --- preparation -----------------------------------------------------------

func TestPrepareCreatesInOrderAndSetsOwnership(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	p := bindPlan()
	p.Torrent.PUID, p.Torrent.PGID = 3, 4
	p.Finalize()

	if _, err := Prepare(Plan(p), fake.ops(), false); err != nil {
		t.Fatal(err)
	}
	if len(fake.created) == 0 || fake.created[0] != "/srv/media" {
		t.Errorf("expected the media root first, got %v", fake.created)
	}
	if fake.chowned["/srv/media"] != "3:4" {
		t.Errorf("ownership = %q, want 3:4", fake.chowned["/srv/media"])
	}
	/*
	 * The mode is asserted after creation, not left to MkdirAll. Its mode is
	 * masked by the process umask — 022 on almost every host — so the
	 * group-writable bit is silently dropped and the directory lands 0755,
	 * breaking the very arrangement PUID/PGID exists to create. Observed on a
	 * real host before this was fixed.
	 */
	if fake.modes["/srv/media"] != DirMode {
		t.Errorf("mode = %#o, want %#o (umask would otherwise drop the group bit)",
			fake.modes["/srv/media"], DirMode)
	}
}

func TestPrepareNeverTouchesWhatAlreadyExists(t *testing.T) {
	/*
	 * The one thing on the host that cannot be regenerated. A recursive chown of
	 * an existing media tree is slow, hard to undo, and on a NAS routinely wrong,
	 * because the tree is often shared with other applications that expect their
	 * own ownership. The installer owns what it creates and reports the rest.
	 */
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	fake.addDir("/srv/media", 1000, 1000)
	p := bindPlan()
	p.Torrent.PUID, p.Torrent.PGID = 3, 4
	p.Finalize()

	actions, err := Prepare(Plan(p), fake.ops(), false)
	if err != nil {
		t.Fatal(err)
	}
	if _, chowned := fake.chowned["/srv/media"]; chowned {
		t.Error("an existing media tree must never be chowned")
	}
	var reported bool
	for _, a := range actions {
		if a.Path == "/srv/media" && a.Kind == "unchanged" {
			reported = true
		}
	}
	if !reported {
		t.Error("it should be reported as left alone, not silently skipped")
	}
}

func TestDryRunCreatesNothing(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	actions, err := Prepare(Plan(bindPlan()), fake.ops(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.created) != 0 {
		t.Errorf("a dry run created %v", fake.created)
	}
	if len(actions) == 0 {
		t.Error("it should still say what it would do")
	}
}

func TestPrepareStopsOnAFileInTheWay(t *testing.T) {
	fake := newFakeFS()
	fake.addDir("/srv", 0, 0)
	fake.files["/srv/media"] = &fakeFile{dir: false}
	if _, err := Prepare(Plan(bindPlan()), fake.ops(), false); err == nil {
		t.Error("expected a refusal rather than a silent skip")
	}
}
