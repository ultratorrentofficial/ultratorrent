// Package plan is the installer's declarative model of an installation.
//
// The wizard's only job is to produce one of these. Nothing in this package
// touches the host: no files, no Docker, no network. That separation is the
// reason the installer can offer a truthful dry run — `plan` and `install
// --dry-run` execute exactly the code below and stop, so what they print is the
// same object the executor would later apply, not a description of it.
//
// Two rules govern what may appear here:
//
//  1. **No secret values, ever.** A plan is meant to be readable, diffable,
//     saved and re-used. Anything that would be dangerous in a file the user
//     might paste into a bug report is either absent or marked `json:"-"`, and
//     a test enforces that by marshalling a fully-populated plan and searching
//     the output for the values.
//  2. **It records decisions, not commands.** "qBittorrent is the engine" is a
//     decision; `docker compose --profile qbittorrent up -d` is a consequence
//     the executor derives. Storing the command would let the plan and the
//     stack disagree the first time the Compose file changed.
package plan

import "time"

// SchemaVersion is the plan format's own version.
//
// Separate from the installer binary's version and from UltraTorrent's, because
// they move for different reasons: a bug fix in the wizard does not change the
// shape of a saved plan, and a new UltraTorrent release usually does not either.
// A future `install --config plan.yaml` compares this and refuses a shape it
// does not understand rather than guessing at missing fields.
const SchemaVersion = 1

// Mode is how much the wizard asks.
type Mode string

const (
	// ModeRecommended asks only what cannot be decided safely on the user's
	// behalf, and generates the rest.
	ModeRecommended Mode = "recommended"
	// ModeAdvanced exposes the settings an experienced operator may need:
	// project name, port overrides, an external engine, explicit profiles.
	ModeAdvanced Mode = "advanced"
)

// Engine is which torrent engine UltraTorrent will use.
type Engine string

const (
	// EngineQbittorrent is the bundled qBittorrent (Compose profile
	// `qbittorrent`). Recommended for new installations — see the engine
	// comparison in docs/DOCKER.md, which records that the bundled rTorrent
	// 0.9.8 has an upstream crash that worsens with active torrent count.
	EngineQbittorrent Engine = "qbittorrent"
	// EngineRtorrent is the bundled rTorrent (Compose profile `rtorrent`).
	EngineRtorrent Engine = "rtorrent"
	// EngineExternal is an engine the operator already runs elsewhere. Nothing
	// is deployed; the installer only registers it with UltraTorrent.
	EngineExternal Engine = "external"
	// EngineNone defers the choice. UltraTorrent boots and is usable without an
	// engine — it simply cannot transfer anything until one is registered.
	EngineNone Engine = "none"
)

// StorageMode is how the `downloads` volume is backed.
type StorageMode string

const (
	// StorageVolume keeps Docker's own named volume. Simplest, and right when
	// the operator does not care where the bytes live.
	StorageVolume StorageMode = "volume"
	// StorageBind points the named volume at a host path.
	//
	// The volume is redefined rather than each service's mount being rewritten:
	// backend, rtorrent and qbittorrent all mount `downloads:/downloads`, so
	// redefining the volume moves all three together and cannot drift, while
	// the in-container path stays `/downloads` and `FILE_MANAGER_ROOTS` and
	// every engine `savePath` keep working untouched.
	StorageBind StorageMode = "bind"
)

// Plan is the complete, validated description of an installation.
type Plan struct {
	SchemaVersion    int    `json:"schemaVersion"`
	InstallerVersion string `json:"installerVersion"`
	// CreatedAt is stamped when the wizard finishes, for the review screen and
	// for the header of every generated file.
	CreatedAt time.Time `json:"createdAt"`

	Mode Mode `json:"mode"`
	// TargetOS is the operating system this plan will be applied to.
	//
	// Recorded rather than inferred at apply time, because every host path in
	// the plan is only meaningful against one of them — and because `filepath`
	// answers for the machine the BINARY was built for, which is not
	// necessarily the machine the plan describes. See target.go.
	TargetOS TargetOS `json:"targetOs"`
	// InstallDirectory holds the Compose file, .env, generated overrides and
	// installer state. Deliberately not where media lives.
	InstallDirectory string `json:"installDirectory"`
	// RepoDirectory holds docker-compose.yml — the project directory Compose is
	// run from, so build contexts and relative paths resolve as they do when an
	// operator runs Compose by hand.
	//
	// Part of the plan rather than a flag alone because a plan is meant to be
	// saved and replayed: one that cannot say where its Compose file lives is
	// not a complete description of the installation. Empty means it was not
	// supplied — deploy refuses rather than searching for one, since guessing a
	// directory is what ProjectName used to do.
	RepoDirectory string `json:"repoDirectory,omitempty"`
	// ForceRebuild builds the images even when they already match the
	// checkout. Not persisted: it describes one run, not the installation.
	ForceRebuild bool `json:"-"`
	// ProjectName is the Compose project, and is always set — see
	// DefaultProjectName. Empty would mean "let Compose derive it from the
	// directory", which is how an installer adopts a stack it did not create:
	// deploy refuses an empty name rather than guessing.
	ProjectName string `json:"projectName,omitempty"`

	Host       Host       `json:"host"`
	Networking Networking `json:"networking"`
	Database   Database   `json:"database"`
	Redis      Redis      `json:"redis"`
	Torrent    Torrent    `json:"torrentEngine"`
	Storage    Storage    `json:"storage"`
	Intake     Intake     `json:"mediaIntake"`
	Companions Companions `json:"companions"`
	Admin      Admin      `json:"administrator"`

	// Secrets carries the actual generated values and is NEVER serialized.
	// Populated at apply time, held in memory, written only into `.env` with
	// 0600. See secrets.go.
	Secrets *Secrets `json:"-"`

	// Profiles is derived from the selections above by ComposeProfiles(). It is
	// recorded so installer-state can replay the exact set — Compose does not
	// persist `--profile`, and a later `up -d` without it stops the profiled
	// services.
	Profiles []string `json:"composeProfiles"`

	// Warnings are non-fatal findings shown on the review screen. A warning
	// never blocks; anything that must block is an error from Validate().
	Warnings []string `json:"warnings,omitempty"`
}

// Host is what pre-flight detected. Filled by the host package (Phase 3); the
// plan carries it so the review screen and a saved plan record the machine the
// decisions were made against.
type Host struct {
	OS             string `json:"os,omitempty"`
	OSVersion      string `json:"osVersion,omitempty"`
	Architecture   string `json:"architecture,omitempty"`
	Hostname       string `json:"hostname,omitempty"`
	DockerVersion  string `json:"dockerVersion,omitempty"`
	ComposeVersion string `json:"composeVersion,omitempty"`
	// WillInstallDocker records that the executor is expected to install it, so
	// the review screen can say so before anything is changed.
	WillInstallDocker bool `json:"willInstallDocker,omitempty"`
}

// Networking is how the deployment is reached.
type Networking struct {
	// FrontendPort is the only port published by the core stack. The backend is
	// not published; the frontend proxies /api and /ws to it.
	FrontendPort int `json:"frontendPort"`
	// PublicURL is the address users will actually type, when known. It becomes
	// CORS_ORIGIN, which the backend enforces.
	PublicURL string `json:"publicUrl,omitempty"`
	// BehindReverseProxy means an existing proxy terminates TLS in front of the
	// frontend port. The installer then deploys no proxy of its own.
	BehindReverseProxy bool `json:"behindReverseProxy"`
	// UseBundledProxy enables the repository's own Caddy profile, which takes
	// ports 80 and 443. Mutually exclusive with BehindReverseProxy.
	UseBundledProxy bool `json:"useBundledProxy"`
}

// Database is the bundled PostgreSQL. It is never published to the host.
type Database struct {
	User string `json:"user"`
	Name string `json:"name"`
	// ConnectionLimit sizes Prisma's pool. Left zero to inherit the Compose
	// default rather than pinning a number the platform may retune.
	ConnectionLimit int `json:"connectionLimit,omitempty"`
}

// Redis is the bundled cache. Internal only; the Compose stack publishes no
// port and the application has no Redis auth setting to configure, so the
// installer does not invent one.
type Redis struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// Torrent is the engine choice and how UltraTorrent will reach it.
type Torrent struct {
	Engine Engine `json:"engine"`
	// PublishWebUI publishes the bundled qBittorrent Web UI on the host. Needed
	// for first-run credential setup unless the installer can pre-seed them.
	PublishWebUI bool `json:"publishWebUi,omitempty"`
	WebUIPort    int  `json:"webUiPort,omitempty"`
	// ExternalURL is where an already-running engine lives, for EngineExternal.
	ExternalURL string `json:"externalUrl,omitempty"`
	// PUID/PGID own the downloaded files. Applied to the engine AND the backend:
	// a deployed host pins the backend's user for exactly this reason, and
	// setting only the engine leaves the backend writing as the wrong user.
	PUID int `json:"puid,omitempty"`
	PGID int `json:"pgid,omitempty"`
	// EnableDHT turns on DHT for the bundled rTorrent. Off by default because
	// that build can crash on a DHT internal_error.
	EnableDHT bool `json:"enableDht,omitempty"`
}

// Storage is where media and staging live.
type Storage struct {
	Mode StorageMode `json:"mode"`
	// MediaRoot is the host path backing the `downloads` volume, for
	// StorageBind. Empty for StorageVolume.
	MediaRoot string `json:"mediaRoot,omitempty"`
	// CreateMissing lets the executor create MediaRoot if it does not exist.
	// Asked rather than assumed: creating a directory on a path the user
	// mistyped is how media ends up on the root disk instead of the array.
	CreateMissing bool `json:"createMissing,omitempty"`
	// Libraries are optional initial libraries, created through the API after
	// the backend is ready — never by writing database rows.
	Libraries []Library `json:"libraries,omitempty"`
}

// Library is one initial media library.
type Library struct {
	Name string `json:"name"`
	// Kind matches UltraTorrent's own library kinds (movie, tv, …). Validated
	// against the API at apply time rather than hard-coded here, so a new kind
	// does not require an installer release.
	Kind string `json:"kind"`
	// Path is the in-container path, under /downloads.
	Path string `json:"path"`
}

// Intake is optional Managed Intake configuration.
type Intake struct {
	Enabled bool `json:"enabled"`
	// StagingPath is the in-container staging root. Downloads land here first
	// and are imported into a library after verification.
	StagingPath string `json:"stagingPath,omitempty"`
	// ProfileName names the Storage Profile the installer will create.
	ProfileName string `json:"profileName,omitempty"`
}

// Companions are the optional side containers.
type Companions struct {
	Prowlarr          bool `json:"prowlarr"`
	ProwlarrPort      int  `json:"prowlarrPort,omitempty"`
	PublishProwlarrUI bool `json:"publishProwlarrUi,omitempty"`
	// FlareSolverr is only meaningful alongside Prowlarr, and is never
	// published: Prowlarr reaches it over the internal network.
	FlareSolverr bool `json:"flaresolverr"`
}

// Admin is the initial administrator, created by the platform's own seed.
type Admin struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	// GeneratePassword is true when the installer mints one. When false the
	// user supplied their own, which still never appears in this struct.
	GeneratePassword bool `json:"generatePassword"`
}

// ComposeProfiles derives the profile set from the selections.
//
// Derived rather than stored as the source of truth so the two cannot disagree:
// a plan that said `prowlarr` while Companions.Prowlarr was false would deploy
// something the review screen never showed.
func (p *Plan) ComposeProfiles() []string {
	profiles := make([]string, 0, 4)
	switch p.Torrent.Engine {
	case EngineQbittorrent:
		profiles = append(profiles, "qbittorrent")
	case EngineRtorrent:
		profiles = append(profiles, "rtorrent")
	}
	if p.Companions.Prowlarr {
		profiles = append(profiles, "prowlarr")
	}
	if p.Companions.FlareSolverr {
		profiles = append(profiles, "flaresolverr")
	}
	if p.Networking.UseBundledProxy {
		profiles = append(profiles, "proxy")
	}
	return profiles
}

// PortBinding is one host port this plan intends to publish.
type PortBinding struct {
	Port  int
	Label string
}

// PublishedPorts lists every host port this plan intends to bind.
//
// A SLICE, not a map keyed by port — which is the whole point. A map silently
// deduplicates, so two services claiming the same port would overwrite each
// other and the collision check built on it could never fire. That is exactly
// what happened here, and it is the failure mode the defaults invite: the
// frontend takes 8080 and qBittorrent's UI defaults to 8081 *because* 8080 is
// taken, so an operator tidying them to one number is a realistic mistake.
//
// One place, so pre-flight's availability check and the review screen cannot
// disagree about what will be taken.
func (p *Plan) PublishedPorts() []PortBinding {
	bindings := []PortBinding{{p.Networking.FrontendPort, "UltraTorrent web UI"}}
	if p.Torrent.Engine == EngineQbittorrent && p.Torrent.PublishWebUI {
		bindings = append(bindings, PortBinding{p.Torrent.WebUIPort, "qBittorrent web UI"})
	}
	if p.Companions.Prowlarr && p.Companions.PublishProwlarrUI {
		bindings = append(bindings, PortBinding{p.Companions.ProwlarrPort, "Prowlarr web UI"})
	}
	if p.Networking.UseBundledProxy {
		bindings = append(bindings,
			PortBinding{80, "Caddy (HTTP)"}, PortBinding{443, "Caddy (HTTPS)"})
	}
	return bindings
}

// SSRFAllowHosts decides what to write for SSRF_ALLOW_HOSTS.
//
// The Compose file defaults this to `prowlarr`, which is what lets the bundled
// indexer's private-IP .torrent links past the SSRF guard. Getting this wrong is
// invisible: auto-downloads fail with a blocked-address error deep in a log and
// everything else looks healthy.
//
// With the bundled indexer, write nothing and inherit the default — that way the
// installer cannot drift from the platform if the default is ever widened.
// Without it, write an explicit empty value so the guard stays at full strength
// rather than the Compose default trusting a Prowlarr this deployment does not
// run.
func (p *Plan) SSRFAllowHosts() (value string, write bool) {
	if p.Companions.Prowlarr {
		return "", false
	}
	return "", true
}
