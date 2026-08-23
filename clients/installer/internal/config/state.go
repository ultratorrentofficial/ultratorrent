package config

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"time"

	"github.com/ultratorrent/installer/internal/plan"
)

// StateSchemaVersion versions installer-state.json independently of the plan.
//
// They change for different reasons: the plan describes what to build, the state
// describes what was built. A future installer reading an older state should
// migrate it rather than refuse — this is a record of someone's live deployment,
// not an input a user can regenerate.
const StateSchemaVersion = 1

// StateFileName is the file's name inside the installation directory.
const StateFileName = "installer-state.json"

// State is what the installer remembers about a deployment.
//
// Explicitly NOT secrets. Those live in `.env` at 0600 and nowhere else; this
// file is readable and exists so `status`, `doctor` and `reconfigure` can
// describe an installation without guessing at it.
//
// It is also how the installer answers "has this host already got UltraTorrent?"
// — one of several signals, because a state file can be deleted while the
// deployment it describes is still running.
type State struct {
	SchemaVersion    int    `json:"schemaVersion"`
	InstallerVersion string `json:"installerVersion"`
	// UltraTorrentVersion is what was deployed, when known. Recorded from the
	// running backend rather than assumed, so an upgrade can compare against
	// reality instead of against what the installer intended.
	UltraTorrentVersion string `json:"ultratorrentVersion,omitempty"`

	InstallDirectory string `json:"installDirectory"`
	ProjectName      string `json:"projectName,omitempty"`

	TorrentEngine string   `json:"torrentEngine"`
	Profiles      []string `json:"composeProfiles"`

	// Ports maps a published host port to what claims it, so `status` can show
	// the topology and `reconfigure` can detect a change.
	Ports map[string]int `json:"ports"`

	StorageMode string `json:"storageMode"`
	MediaRoot   string `json:"mediaRoot,omitempty"`

	Prowlarr         bool `json:"prowlarr"`
	FlareSolverr     bool `json:"flaresolverr"`
	BundledProxy     bool `json:"bundledProxy"`
	IntakeConfigured bool `json:"intakeConfigured"`

	// GeneratedFiles is what the installer owns in this directory. Reconfigure
	// backs up exactly these and nothing else — a file the installer did not
	// write is the operator's, and must not be touched.
	GeneratedFiles []string `json:"generatedFiles"`

	InstalledAt time.Time `json:"installedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// StateFrom builds state from a plan that has just been applied.
func StateFrom(p *plan.Plan, generated []string) *State {
	now := time.Now().UTC()
	ports := map[string]int{"frontend": p.Networking.FrontendPort}
	if p.Torrent.Engine == plan.EngineQbittorrent && p.Torrent.PublishWebUI {
		ports["qbittorrent"] = p.Torrent.WebUIPort
	}
	if p.Companions.Prowlarr && p.Companions.PublishProwlarrUI {
		ports["prowlarr"] = p.Companions.ProwlarrPort
	}

	return &State{
		SchemaVersion:    StateSchemaVersion,
		InstallerVersion: p.InstallerVersion,
		InstallDirectory: p.InstallDirectory,
		ProjectName:      p.ProjectName,
		TorrentEngine:    string(p.Torrent.Engine),
		Profiles:         p.ComposeProfiles(),
		Ports:            ports,
		StorageMode:      string(p.Storage.Mode),
		MediaRoot:        p.Storage.MediaRoot,
		Prowlarr:         p.Companions.Prowlarr,
		FlareSolverr:     p.Companions.FlareSolverr,
		BundledProxy:     p.Networking.UseBundledProxy,
		IntakeConfigured: p.Intake.Enabled,
		GeneratedFiles:   generated,
		InstalledAt:      now,
		UpdatedAt:        now,
	}
}

// WriteState serializes state.
func WriteState(w io.Writer, s *State) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(s)
}

// ReadState loads state.
//
// A newer schema is accepted with a warning rather than refused, which is the
// opposite of the plan's rule and deliberately so: a plan is an input the user
// can regenerate, while this describes a deployment that already exists. An
// installer that refused to read it would be unable to tell the operator
// anything about the very installation it is standing in.
func ReadState(r io.Reader) (*State, []string, error) {
	var s State
	if err := json.NewDecoder(r).Decode(&s); err != nil {
		return nil, nil, fmt.Errorf("reading installer state: %w", err)
	}
	var warnings []string
	if s.SchemaVersion > StateSchemaVersion {
		warnings = append(warnings, fmt.Sprintf(
			"installer state was written by a newer installer (schema %d, this one speaks %d); "+
				"some settings may not be shown", s.SchemaVersion, StateSchemaVersion))
	}
	return &s, warnings, nil
}

// CarryForward preserves facts a freshly built state cannot know.
//
// InstalledAt above all: it is written from time.Now() every run, so without
// this the record of when the installation actually happened is destroyed by the
// first re-run — and it is exactly the fact nothing else can reconstruct.
//
// When the deployment's shape has not changed, UpdatedAt is carried forward too.
// That makes the rendered file byte-identical, so the writer's ordinary
// "unchanged" path applies and a no-op re-run leaves no backup behind. A
// timestamp that moves on its own would otherwise make every run look like a
// change and fill the directory with backups of nothing.
func (s *State) CarryForward(previous *State) {
	if previous == nil {
		return
	}
	if !previous.InstalledAt.IsZero() {
		s.InstalledAt = previous.InstalledAt
	}
	if s.UltraTorrentVersion == "" {
		s.UltraTorrentVersion = previous.UltraTorrentVersion
	}
	if s.SameShape(previous) {
		s.UpdatedAt = previous.UpdatedAt
	}
}

// SameShape reports whether two states describe the same deployment, ignoring
// when they were written.
//
// Compared by value over zeroed copies rather than field by field on purpose: a
// hand-written comparison silently stops covering a field the moment one is
// added, and the failure is invisible — a real change that reports "unchanged".
func (s *State) SameShape(other *State) bool {
	if s == nil || other == nil {
		return s == other
	}
	a, b := *s, *other
	a.InstalledAt, b.InstalledAt = time.Time{}, time.Time{}
	a.UpdatedAt, b.UpdatedAt = time.Time{}, time.Time{}
	return reflect.DeepEqual(a, b)
}
