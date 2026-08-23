package config

import (
	"errors"
	"fmt"

	"github.com/ultratorrent/installer/internal/plan"
)

// ErrTargetNotImplemented is returned when a plan is valid but cannot yet be
// applied on the operating system it targets.
var ErrTargetNotImplemented = errors.New("target not implemented")

// CheckTarget refuses to generate configuration this installer cannot yet write
// correctly.
//
// A plan is a DOCUMENT and a Windows plan is a perfectly valid one — it can be
// authored, printed, saved, diffed and reviewed on any machine, which is why
// validation accepts it. What does not yet exist is the generator: every volume
// this installer writes uses
//
//	driver_opts: { type: none, o: bind, device: <host path> }
//
// which is a Linux mount(2) performed INSIDE the Docker VM. `D:\Media` is not a
// path in there, and Docker Desktop's own mount root for host drives is an
// implementation detail rather than a documented interface. Emitting that YAML
// for a Windows host would produce a stack that comes up and silently stores
// everything in the wrong place — the worst available outcome, and the reason
// this refuses instead.
//
// Settling it is an experiment on a real Docker Desktop host, not a design
// decision: see W3 in docs/WINDOWS_INSTALLER_GAP_ANALYSIS.md. When it is
// settled this function is where the restriction is lifted.
func CheckTarget(p *plan.Plan) error {
	if p.TargetOS != plan.TargetWindows {
		return nil
	}
	return fmt.Errorf(
		"%w: this build can plan a Windows installation but not generate one. "+
			"Every volume it writes binds a host path with Docker's local driver, "+
			"which performs a Linux mount inside the Docker VM — a Windows path is "+
			"not visible there, and the correct form has to be established on a real "+
			"Docker Desktop host before it can be written. See W3 in "+
			"docs/WINDOWS_INSTALLER_GAP_ANALYSIS.md",
		ErrTargetNotImplemented)
}
