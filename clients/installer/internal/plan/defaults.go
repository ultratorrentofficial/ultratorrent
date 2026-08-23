package plan

import (
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// Defaults for a Recommended-mode installation.
//
// Every value here matches what the repository already does, so a default
// install and a documented hand-install produce the same stack. Where the
// Compose file has a default, this repeats it deliberately rather than choosing
// something "better" — an installer whose defaults differ from the documentation
// makes every existing troubleshooting page subtly wrong.
const (
	// DefaultInstallDirectory follows the FHS convention for add-on software.
	DefaultInstallDirectory = "/opt/ultratorrent"

	// DefaultFrontendPort matches FRONTEND_PORT in docker-compose.yml.
	DefaultFrontendPort = 8080
	// DefaultQbittorrentPort matches QBITTORRENT_PORT. It is 8081 rather than
	// 8080 precisely because the frontend already holds 8080.
	DefaultQbittorrentPort = 8081
	// DefaultProwlarrPort matches PROWLARR_PORT.
	DefaultProwlarrPort = 9696

	DefaultDatabaseUser = "ultratorrent"
	DefaultDatabaseName = "ultratorrent"
	DefaultRedisHost    = "redis"
	DefaultRedisPort    = 6379

	DefaultAdminUsername = "admin"
	DefaultAdminEmail    = "admin@ultratorrent.local"

	// DefaultMediaRoot is generic on purpose. /srv is where the FHS puts data
	// served by this machine, and nothing here assumes a NAS layout, a mount
	// point, or any particular media server.
	DefaultMediaRoot = "/srv/ultratorrent/media"

	// DefaultStagingPath is inside the shared tree, because intake must be able
	// to move a finished download into a library — and a move across
	// filesystems is a copy, which defeats the point.
	DefaultStagingPath = "/downloads/Staging"
	DefaultProfileName = "Default"
)

// Recommended returns a plan pre-filled with safe defaults.
//
// The wizard starts here and overwrites what the user chooses, so an unanswered
// question always lands on the documented default rather than a zero value.
func Recommended(installerVersion string) *Plan {
	return &Plan{
		SchemaVersion:    SchemaVersion,
		InstallerVersion: installerVersion,
		CreatedAt:        time.Now().UTC(),
		Mode:             ModeRecommended,
		InstallDirectory: DefaultInstallDirectory,
		Networking: Networking{
			FrontendPort: DefaultFrontendPort,
		},
		Database: Database{
			User: DefaultDatabaseUser,
			Name: DefaultDatabaseName,
		},
		Redis: Redis{
			Host: DefaultRedisHost,
			Port: DefaultRedisPort,
		},
		Torrent: Torrent{
			// qBittorrent, per the engine comparison the repository already
			// documents. The Web UI is published because first-run credentials
			// currently require reaching it.
			Engine:       EngineQbittorrent,
			PublishWebUI: true,
			WebUIPort:    DefaultQbittorrentPort,
		},
		Companions: Companions{
			// Ports carried even while the companions are off, so enabling one
			// later — in the wizard or in reconfigure — cannot leave it on port
			// zero. Validation would catch that, but a default the user never
			// has to think about is better than an error they have to fix.
			ProwlarrPort:      DefaultProwlarrPort,
			PublishProwlarrUI: true,
		},
		Storage: Storage{
			// A Docker volume by default: it always works, needs no host path,
			// and cannot be pointed at the wrong directory. Choosing a host path
			// is a deliberate step, not an accident of the default.
			Mode: StorageVolume,
		},
		Admin: Admin{
			Username:         DefaultAdminUsername,
			Email:            DefaultAdminEmail,
			GeneratePassword: true,
		},
	}
}

// Finalize derives everything computed from the choices and stamps the plan.
//
// Called once when the wizard finishes and again after any reconfigure edit, so
// the derived fields can never lag behind the selections that produced them.
func (p *Plan) Finalize() {
	p.Profiles = p.ComposeProfiles()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now().UTC()
	}
	p.Warnings = nil
	for _, problem := range Warnings(p.Validate()) {
		p.Warnings = append(p.Warnings, problem.String())
	}
}

// WriteJSON serializes the plan.
//
// Indented because a plan is meant to be read and diffed by a person. Secrets
// cannot appear: every field on Secrets is `json:"-"`, and a test asserts it by
// marshalling a populated plan and searching for the values.
func (p *Plan) WriteJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(p)
}

// ReadJSON loads a plan and refuses a schema it does not understand.
//
// Refusing beats best-effort parsing: a plan from a newer installer may contain
// decisions this build would silently drop, and silently dropping a decision
// during an install is how a stack ends up not matching what its operator
// reviewed.
func ReadJSON(r io.Reader) (*Plan, error) {
	var p Plan
	if err := json.NewDecoder(r).Decode(&p); err != nil {
		return nil, fmt.Errorf("reading plan: %w", err)
	}
	if p.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf(
			"plan schema %d is not supported by this installer (which speaks %d)",
			p.SchemaVersion, SchemaVersion)
	}
	return &p, nil
}
