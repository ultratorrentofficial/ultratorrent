// Package storage prepares the host filesystem an installation needs.
//
// It exists because of a hard dependency, confirmed by experiment: a bind-backed
// volume whose device does not exist does not fail at `docker compose config`
// and does not get created on demand — the container fails to START, with
//
//	failed to mount local volume: mount /srv/media:/var/lib/docker/volumes/…
//
// which names an internal Docker path and gives no hint that the real problem is
// a missing directory on the host. So directories are created BEFORE anything is
// deployed, and what cannot be created is reported before it becomes that error.
//
// The other half is the container/host path split. `/downloads` inside every
// container is MediaRoot on the host, and the plan deliberately keeps the two
// kinds of path apart — library and staging paths are container paths, MediaRoot
// is a host path. Resolving between them is this package's job and nothing else's.
package storage

import (
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ultratorrent/installer/internal/plan"
)

// ContainerRoot is where the shared media tree appears inside every container.
//
// Fixed by docker-compose.yml, which mounts `downloads:/downloads` into backend,
// rtorrent and qbittorrent alike. FILE_MANAGER_ROOTS and every engine save path
// are expressed against it, which is why the bind redefines the VOLUME rather
// than any service's mount — the in-container path must not move.
const ContainerRoot = "/downloads"

// DirMode is the mode created directories get.
//
// Group-writable because the engine and the backend may run as different users
// sharing a group, which is the ownership arrangement PUID/PGID exists to
// create. Not world-writable: this tree holds the operator's media.
const DirMode fs.FileMode = 0o775

// Directory is one directory the installation needs on the host.
type Directory struct {
	// Path is on the HOST. Always absolute.
	Path string
	// ContainerPath is where the same directory appears inside the containers,
	// empty if it is not mounted.
	ContainerPath string
	// Purpose is shown to the operator, so a wrong path is recognisable as wrong
	// before it is created.
	Purpose string
	// Required marks a directory that must exist before the stack is started.
	// A bind device is required; a convenience subdirectory is not.
	Required bool
	// Owner is the uid/gid to give it, when the plan set PUID/PGID.
	Owner *Ownership
}

// Ownership is a uid/gid pair.
type Ownership struct{ UID, GID int }

func (o Ownership) String() string { return fmt.Sprintf("%d:%d", o.UID, o.GID) }

// Plan lists the directories an installation needs, in creation order.
//
// Pure: no filesystem access, so "what would this plan create" is a table test.
// Parents come before children, because creating them in order lets each one be
// reported separately — a single MkdirAll would create four levels and be able
// to say only that it made the last.
func Plan(p *plan.Plan) []Directory {
	// A named volume is Docker's own; there is nothing on the host to prepare,
	// and inventing a path would be worse than doing nothing.
	if p.Storage.Mode != plan.StorageBind || p.Storage.MediaRoot == "" {
		return nil
	}

	var owner *Ownership
	if p.Torrent.PUID > 0 || p.Torrent.PGID > 0 {
		owner = &Ownership{UID: p.Torrent.PUID, GID: p.Torrent.PGID}
	}

	root := filepath.Clean(p.Storage.MediaRoot)
	dirs := []Directory{{
		Path:          root,
		ContainerPath: ContainerRoot,
		Purpose:       "media root — the host directory behind /downloads",
		Required:      true,
		Owner:         owner,
	}}

	// Everything else is expressed as a CONTAINER path in the plan and has to be
	// resolved back to the host to be created.
	seen := map[string]bool{root: true}
	add := func(containerPath, purpose string) {
		hostPath, ok := HostPath(p, containerPath)
		if !ok || seen[hostPath] {
			return
		}
		seen[hostPath] = true
		dirs = append(dirs, Directory{
			Path:          hostPath,
			ContainerPath: path.Clean(containerPath),
			Purpose:       purpose,
			// The engine creates its own save paths; these are created so the
			// operator sees the layout, and so ownership is right from the start.
			Required: false,
			Owner:    owner,
		})
	}

	// The engine's incomplete-downloads directory, which the generated engine
	// config points at.
	add(ContainerRoot+"/incomplete", "in-progress downloads")

	if p.Intake.Enabled && p.Intake.StagingPath != "" {
		add(p.Intake.StagingPath, "Managed Intake staging — downloads land here first")
	}
	for _, lib := range p.Storage.Libraries {
		if lib.Path != "" {
			add(lib.Path, fmt.Sprintf("library %q", lib.Name))
		}
	}

	sortByDepth(dirs)
	return dirs
}

// HostPath maps an in-container path to its host equivalent.
//
// Only meaningful for a bind-backed installation: with a named volume the bytes
// live inside Docker's own storage and there is no host path worth naming. The
// boolean says which, rather than returning a plausible-looking path that is not
// real — a caller that then created it would be making a directory nothing uses.
func HostPath(p *plan.Plan, containerPath string) (string, bool) {
	if p.Storage.Mode != plan.StorageBind || p.Storage.MediaRoot == "" {
		return "", false
	}
	clean := path.Clean(containerPath)
	if clean != ContainerRoot && !strings.HasPrefix(clean, ContainerRoot+"/") {
		// Outside the shared tree: not something this installation maps.
		return "", false
	}
	relative := strings.TrimPrefix(clean, ContainerRoot)
	return filepath.Join(filepath.Clean(p.Storage.MediaRoot), filepath.FromSlash(relative)), true
}

// ContainerPathFor maps a host path back into the containers.
//
// The reverse direction matters for diagnostics: an operator reads a host path
// off their own filesystem and needs to know what UltraTorrent calls it.
func ContainerPathFor(p *plan.Plan, hostPath string) (string, bool) {
	if p.Storage.Mode != plan.StorageBind || p.Storage.MediaRoot == "" {
		return "", false
	}
	root := filepath.Clean(p.Storage.MediaRoot)
	clean := filepath.Clean(hostPath)
	if clean == root {
		return ContainerRoot, true
	}
	relative, err := filepath.Rel(root, clean)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return path.Join(ContainerRoot, filepath.ToSlash(relative)), true
}

// sortByDepth orders parents before children so each is created and reported
// individually.
func sortByDepth(dirs []Directory) {
	sort.SliceStable(dirs, func(i, j int) bool {
		di := strings.Count(dirs[i].Path, string(filepath.Separator))
		dj := strings.Count(dirs[j].Path, string(filepath.Separator))
		if di != dj {
			return di < dj
		}
		return dirs[i].Path < dirs[j].Path
	})
}
