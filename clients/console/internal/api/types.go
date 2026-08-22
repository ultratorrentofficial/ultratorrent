// Package api speaks the UltraTorrent operations contract.
//
// The types below mirror packages/shared/src/operations.ts. They are a
// hand-written mirror rather than generated code because the surface is small,
// stable and versioned: OPERATIONS_CONTRACT_VERSION tells this client whether
// what it is holding still matches, which is a guarantee no amount of codegen
// would add. Every field is a pointer or a zero-safe value, so a backend that
// omits something a newer console knows about degrades to "unknown" instead of
// failing to decode.
package api

// ContractMajor is the contract this build understands.
//
// Compared against the server's OPERATIONS_CONTRACT_VERSION: same major means
// compatible, a newer minor means compatible with fields this build ignores,
// and a different major means the console says so plainly rather than rendering
// nonsense from a shape it is guessing at.
const ContractMajor = 1

// Health mirrors OperationsHealth.
type Health string

const (
	HealthHealthy  Health = "healthy"
	HealthDegraded Health = "degraded"
	HealthDown     Health = "down"
	HealthUnknown  Health = "unknown"
)

// Severity mirrors OperationsSeverity.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityError    Severity = "error"
	SeverityCritical Severity = "critical"
)

// Domain is one panel's worth of the snapshot.
//
// The Reason field is what makes a missing panel legible: "forbidden" and
// "unavailable" send an operator to two different places, and the console must
// not collapse them into one grey box.
type Domain[T any] struct {
	Available bool   `json:"available"`
	Data      T      `json:"data"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
}

type System struct {
	Product       string    `json:"product"`
	Version       string    `json:"version"`
	APIVersion    string    `json:"apiVersion"`
	GitSha        *string   `json:"gitSha"`
	GitTag        *string   `json:"gitTag"`
	BuildTime     *string   `json:"buildTime"`
	NodeVersion   string    `json:"nodeVersion"`
	UptimeSeconds int64     `json:"uptimeSeconds"`
	MemoryBytes   int64     `json:"memoryBytes"`
	LoadAverage   []float64 `json:"loadAverage"`
	CPUCount      int       `json:"cpuCount"`
	Database      Health    `json:"database"`
	Cache         Health    `json:"cache"`
}

type StorageRoot struct {
	Path        string   `json:"path"`
	TotalBytes  int64    `json:"totalBytes"`
	FreeBytes   int64    `json:"freeBytes"`
	UsedBytes   int64    `json:"usedBytes"`
	UsedPercent *float64 `json:"usedPercent"`
	Health      Health   `json:"health"`
	Error       string   `json:"error"`
}

type Storage struct {
	Roots []StorageRoot `json:"roots"`
}

type Torrent struct {
	Hash            string  `json:"hash"`
	Name            string  `json:"name"`
	EngineID        string  `json:"engineId"`
	State           string  `json:"state"`
	Progress        float64 `json:"progress"`
	SizeBytes       int64   `json:"sizeBytes"`
	DownloadRate    int64   `json:"downloadRate"`
	UploadRate      int64   `json:"uploadRate"`
	Ratio           float64 `json:"ratio"`
	ETA             *int64  `json:"eta"`
	SeedsConnected  int     `json:"seedsConnected"`
	PeersConnected  int     `json:"peersConnected"`
	AddedAt         *string `json:"addedAt"`
	CompletedAt     *string `json:"completedAt"`
	Message         *string `json:"message"`
	Parked          bool    `json:"parked"`
	ParkedReason    *string `json:"parkedReason"`
	IntakeState     *string `json:"intakeState"`
	Stalled         bool    `json:"stalled"`
}

type TorrentCounts struct {
	Total       int `json:"total"`
	Downloading int `json:"downloading"`
	Seeding     int `json:"seeding"`
	Paused      int `json:"paused"`
	Queued      int `json:"queued"`
	Checking    int `json:"checking"`
	Errored     int `json:"errored"`
	Stalled     int `json:"stalled"`
	Parked      int `json:"parked"`
}

type TorrentRates struct {
	DownloadRate    int64   `json:"downloadRate"`
	UploadRate      int64   `json:"uploadRate"`
	TotalDownloaded int64   `json:"totalDownloaded"`
	TotalUploaded   int64   `json:"totalUploaded"`
	Ratio           float64 `json:"ratio"`
}

type Torrents struct {
	Counts    TorrentCounts `json:"counts"`
	Rates     TorrentRates  `json:"rates"`
	Active    []Torrent     `json:"active"`
	Attention []Torrent     `json:"attention"`
	Truncated bool          `json:"truncated"`
	// ObservedAt is when the poller last looked, NOT when the snapshot was
	// built. Contract 1.1.0 and later; empty on an older server, which the UI
	// renders as unknown rather than as "now".
	ObservedAt *string `json:"observedAt"`
}

type QueueEntry struct {
	EngineID    string  `json:"engineId"`
	TorrentHash string  `json:"torrentHash"`
	Name        string  `json:"name"`
	Decision    string  `json:"decision"`
	Reason      *string `json:"reason"`
}

type Queue struct {
	EngineModes []struct {
		EngineID string `json:"engineId"`
		Mode     string `json:"mode"`
		Health   Health `json:"health"`
	} `json:"engineModes"`
	Entries   []QueueEntry `json:"entries"`
	Truncated bool         `json:"truncated"`
}

type IntakeJob struct {
	ID    string  `json:"id"`
	Title string  `json:"title"`
	State string  `json:"state"`
	Error *string `json:"error"`
	At    string  `json:"at"`
}

type MediaIntake struct {
	ByState        map[string]int `json:"byState"`
	Active         int            `json:"active"`
	Failed         int            `json:"failed"`
	Quarantined    int            `json:"quarantined"`
	ImportedToday  int            `json:"importedToday"`
	Recent         []IntakeJob    `json:"recent"`
	Truncated      bool           `json:"truncated"`
}

type Media struct {
	TotalItems    int            `json:"totalItems"`
	ByType        map[string]int `json:"byType"`
	Unmatched     int            `json:"unmatched"`
	LowConfidence int            `json:"lowConfidence"`
}

type PlaybackSession struct {
	User      string  `json:"user"`
	Title     string  `json:"title"`
	Player    string  `json:"player"`
	State     string  `json:"state"`
	Progress  float64 `json:"progress"`
	Transcode bool    `json:"transcode"`
}

type Playback struct {
	Sessions       []PlaybackSession `json:"sessions"`
	Transcoding    int               `json:"transcoding"`
	DirectPlaying  int               `json:"directPlaying"`
	Truncated      bool              `json:"truncated"`
}

type Job struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Status   string  `json:"status"`
	Progress *int    `json:"progress"`
	Error    *string `json:"errorCode"`
	At       string  `json:"at"`
}

type Jobs struct {
	ByStatus       map[string]int `json:"byStatus"`
	Running        int            `json:"running"`
	Queued         int            `json:"queued"`
	Failed         int            `json:"failed"`
	Active         int            `json:"active"`
	CompletedToday int            `json:"completedToday"`
	FailedToday    int            `json:"failedToday"`
	SuccessRate    *float64       `json:"successRate"`
	Recent         []Job          `json:"recent"`
	Truncated      bool           `json:"truncated"`
}

type AutomationRun struct {
	RuleName string  `json:"ruleName"`
	Result   string  `json:"result"`
	At       string  `json:"at"`
	Detail   *string `json:"detail"`
}

type Automation struct {
	Rules []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	} `json:"rules"`
	RecentRuns  []AutomationRun `json:"recentRuns"`
	Failures24h int             `json:"failures24h"`
	Truncated   bool            `json:"truncated"`
}

type AcquisitionEvent struct {
	ID           string  `json:"id"`
	FeedName     *string `json:"feedName"`
	RuleName     *string `json:"ruleName"`
	ReleaseTitle string  `json:"releaseTitle"`
	Result       string  `json:"result"`
	Reason       *string `json:"reason"`
	At           string  `json:"at"`
}

type Acquisition struct {
	Feeds []struct {
		Name                   string  `json:"name"`
		Enabled                bool    `json:"enabled"`
		LastPolledAt           *string `json:"lastPolledAt"`
		RefreshIntervalSeconds int     `json:"refreshIntervalSeconds"`
		RuleCount              int     `json:"ruleCount"`
	} `json:"feeds"`
	Recent    []AcquisitionEvent `json:"recent"`
	Grabs24h  int                `json:"grabs24h"`
	Truncated bool               `json:"truncated"`
}

type Engine struct {
	EngineID     string  `json:"engineId"`
	Kind         string  `json:"kind"`
	Health       Health  `json:"health"`
	LastSeenAt   *string `json:"lastSeenAt"`
	Error        *string `json:"error"`
	Version      *string `json:"version"`
	TorrentCount *int    `json:"torrentCount"`
}

type Indexer struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Protocol     string  `json:"protocol"`
	Enabled      bool    `json:"enabled"`
	Priority     int     `json:"priority"`
	Health       Health  `json:"health"`
	Message      *string `json:"message"`
	LastTestedAt *string `json:"lastTestedAt"`
}

type Provider struct {
	Category      string   `json:"category"`
	Key           string   `json:"key"`
	Name          string   `json:"name"`
	Enabled       bool     `json:"enabled"`
	Health        Health   `json:"health"`
	Message       *string  `json:"message"`
	Version       *string  `json:"version"`
	LastCheckedAt *string  `json:"lastCheckedAt"`
	Capabilities  []string `json:"capabilities"`
}

type Notifications struct {
	Last24h    map[string]int `json:"last24h"`
	Pending    int            `json:"pending"`
	Failed24h  int            `json:"failed24h"`
	Recent     []struct {
		EventKey    string  `json:"eventKey"`
		ChannelType string  `json:"channelType"`
		Status      string  `json:"status"`
		Error       *string `json:"error"`
		At          string  `json:"at"`
	} `json:"recent"`
	Truncated bool `json:"truncated"`
}

type ActivityItem struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	Message    string  `json:"message"`
	Detail     *string `json:"detail"`
	Level      string  `json:"level"`
	EventCount int     `json:"eventCount"`
	At         string  `json:"at"`
}

type Alert struct {
	ID       string   `json:"id"`
	Severity Severity `json:"severity"`
	Domain   string   `json:"domain"`
	Title    string   `json:"title"`
	Detail   *string  `json:"detail"`
	Since    *string  `json:"since"`
}

// Snapshot mirrors OperationsSnapshot.
type Snapshot struct {
	ContractVersion string `json:"contractVersion"`
	GeneratedAt     string `json:"generatedAt"`
	DurationMs      int    `json:"durationMs"`
	Domains         struct {
		System         *Domain[System]         `json:"system"`
		Storage        *Domain[Storage]        `json:"storage"`
		Torrents       *Domain[Torrents]       `json:"torrents"`
		Queue          *Domain[Queue]          `json:"queue"`
		MediaIntake    *Domain[MediaIntake]    `json:"mediaIntake"`
		Media          *Domain[Media]          `json:"media"`
		Playback       *Domain[Playback]       `json:"playback"`
		Jobs           *Domain[Jobs]           `json:"jobs"`
		Automation     *Domain[Automation]     `json:"automation"`
		Acquisition    *Domain[Acquisition]    `json:"acquisition"`
		Engines        *Domain[[]Engine]       `json:"engines"`
		Indexers       *Domain[[]Indexer]      `json:"indexers"`
		Providers      *Domain[[]Provider]     `json:"providers"`
		Notifications  *Domain[Notifications]  `json:"notifications"`
		RecentActivity *Domain[[]ActivityItem] `json:"recentActivity"`
		Alerts         *Domain[[]Alert]        `json:"alerts"`
	} `json:"domains"`
}

// Capabilities mirrors OperationsCapabilities.
type Capabilities struct {
	ContractVersion string `json:"contractVersion"`
	Server          struct {
		Product    string  `json:"product"`
		Version    string  `json:"version"`
		APIVersion string  `json:"apiVersion"`
		GitSha     *string `json:"gitSha"`
		GitTag     *string `json:"gitTag"`
		BuildTime  *string `json:"buildTime"`
	} `json:"server"`
	AvailableDomains []string `json:"availableDomains"`
	PermittedDomains []string `json:"permittedDomains"`
	User             struct {
		ID          string   `json:"id"`
		Username    string   `json:"username"`
		Roles       []string `json:"roles"`
		Permissions []string `json:"permissions"`
	} `json:"user"`
	EventChannel string `json:"eventChannel"`
	Limits       struct {
		MaxItemsPerDomain         int `json:"maxItemsPerDomain"`
		MinSnapshotIntervalSeconds int `json:"minSnapshotIntervalSeconds"`
	} `json:"limits"`
}

// Permits reports whether the caller may read a domain.
//
// The console hides what it cannot fetch rather than rendering a permission
// error per panel — but this is a display convenience only. The server re-checks
// every domain, so a client bug here cannot widen what anyone can see.
func (c *Capabilities) Permits(domain string) bool {
	for _, d := range c.PermittedDomains {
		if d == domain {
			return true
		}
	}
	return false
}
