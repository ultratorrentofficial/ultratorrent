// Package engine configures the bundled torrent engine before it first starts.
//
// The point is to remove a step that today is documented rather than solved:
// docker-compose.yml tells the operator to read a temporary password out of the
// container logs. That is scraping by another name — it is racy (the line scrolls
// away), it puts a live credential in `docker logs` and in whatever gets pasted
// into an issue, and it cannot be automated. Everything here exists so the engine
// comes up already holding a credential the installer chose.
package engine

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"strings"
)

// qBittorrent's own PBKDF2 parameters, taken from its source and confirmed
// empirically against qBittorrent 5.2.3: a value written with these is accepted
// as a password, and the engine issues no temporary one.
//
// They are not configurable. Getting any of them wrong produces a file
// qBittorrent accepts as "a password is set" while rejecting every login — a
// failure that looks like a wrong password rather than a wrong format.
const (
	pbkdf2Iterations = 100000
	pbkdf2KeyLength  = 64
	pbkdf2SaltLength = 16
)

// ConfigPath is where the engine's settings live inside its config volume.
const ConfigPath = "qBittorrent/qBittorrent.conf"

// Verifier renders qBittorrent's stored password verifier.
//
// The salt is a parameter rather than generated inside, so the computation is a
// pure function that a test can check against a value qBittorrent itself
// produced. Callers use NewVerifier.
func Verifier(password string, salt []byte) string {
	key, err := pbkdf2.Key(sha512.New, password, salt, pbkdf2Iterations, pbkdf2KeyLength)
	if err != nil {
		// Only reachable with a nonsensical key length, which is a constant here.
		panic("engine: pbkdf2: " + err.Error())
	}
	return base64.StdEncoding.EncodeToString(salt) + ":" +
		base64.StdEncoding.EncodeToString(key)
}

// NewVerifier renders a verifier over a fresh random salt.
func NewVerifier(password string) (string, error) {
	salt := make([]byte, pbkdf2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating a salt: %w", err)
	}
	return Verifier(password, salt), nil
}

// Settings is what the installer decides about the bundled engine.
type Settings struct {
	Username string
	Password string
	// Port is the WebUI port INSIDE the container. When the UI is published it
	// must equal the host port — see RelaxHostHeaderValidation.
	Port int
	// SavePath and TempPath are container paths under the shared downloads tree.
	SavePath string
	TempPath string
	// RelaxHostHeaderValidation turns off qBittorrent's check that the port in a
	// request's Host header matches its own WebUI port.
	//
	// Needed only when the UI is published on a host port that differs from the
	// container port, which is the shipped Compose default (8081:8080) and the
	// reason its documented "read the temporary password from the logs" workflow
	// cannot work: a browser sends `Host: host:8081`, the ports disagree, and
	// qBittorrent answers 401 to every request including the login page.
	//
	// Aligning the ports is the better fix and is preferred wherever the
	// installer can arrange it; this exists for the case where it cannot.
	RelaxHostHeaderValidation bool
}

// RenderConfig produces qBittorrent.conf.
//
// Written for a config volume that is EMPTY. qBittorrent rewrites this file
// itself as the operator changes settings in the UI, so the installer generates
// it once, before first start, and never again — regenerating it later would
// silently discard everything the operator has since configured.
func RenderConfig(s Settings) string {
	var b strings.Builder

	// Without this qBittorrent shows a legal notice and refuses to start
	// unattended, which for a container means a boot loop with no obvious cause.
	b.WriteString("[LegalNotice]\nAccepted=true\n\n")

	b.WriteString("[BitTorrent]\n")
	fmt.Fprintf(&b, "Session\\DefaultSavePath=%s\n", s.SavePath)
	fmt.Fprintf(&b, "Session\\TempPath=%s\n", s.TempPath)
	b.WriteString("\n[Preferences]\n")
	fmt.Fprintf(&b, "Downloads\\SavePath=%s\n", s.SavePath)
	fmt.Fprintf(&b, "Downloads\\TempPath=%s\n", s.TempPath)
	// Listen on every interface within the container network; the container
	// boundary is what limits reachability, not this.
	b.WriteString("WebUI\\Address=*\n")
	fmt.Fprintf(&b, "WebUI\\Port=%d\n", s.Port)
	fmt.Fprintf(&b, "WebUI\\Username=%s\n", s.Username)
	if s.RelaxHostHeaderValidation {
		b.WriteString("WebUI\\HostHeaderValidation=false\n")
	}
	return b.String()
}

// RenderConfigWithPassword renders the file including the password verifier.
//
// Separate from RenderConfig so the rest of the file can be rendered, compared
// and shown without a credential anywhere near it.
func RenderConfigWithPassword(s Settings, verifier string) string {
	config := RenderConfig(s)
	// Appended inside [Preferences]; the section runs to the end of the file.
	return config + fmt.Sprintf("WebUI\\Password_PBKDF2=\"@ByteArray(%s)\"\n", verifier)
}
