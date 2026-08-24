package companion

import "testing"

// Prowlarr owns config.xml after first start, so the installer never rewrites
// it and never keeps a copy of the key. Reading the key back out is the only
// way a later run can finish wiring the integration.
func TestTheKeyIsReadBackOutOfProwlarrsOwnConfig(t *testing.T) {
	// Shaped like the real file, including the elements around it.
	const real = `<?xml version="1.0" encoding="utf-8"?>
<Config>
  <BindAddress>*</BindAddress>
  <Port>9696</Port>
  <ApiKey>8ac8f2b1c4d94e0fa1b2c3d4e5f60718</ApiKey>
  <AuthenticationMethod>None</AuthenticationMethod>
</Config>`
	if got := ParseAPIKey(real); got != "8ac8f2b1c4d94e0fa1b2c3d4e5f60718" {
		t.Errorf("got %q, want the key", got)
	}
}

func TestWhatItSeedsIsWhatItReadsBack(t *testing.T) {
	// The round trip that matters: the installer's own rendering must be
	// readable by its own parser, or a seeded installation cannot be rewired.
	rendered := RenderProwlarrConfig(ProwlarrSettings{APIKey: "0123456789abcdef0123456789abcdef", Port: 9696})
	if got := ParseAPIKey(rendered); got != "0123456789abcdef0123456789abcdef" {
		t.Errorf("could not read back its own output: %q", got)
	}
}

func TestNoKeyIsAnEmptyAnswerRatherThanRubbish(t *testing.T) {
	for name, xml := range map[string]string{
		"empty":          "",
		"no element":     "<Config><Port>9696</Port></Config>",
		"unterminated":   "<Config><ApiKey>abc",
		"not xml at all": "this is not a config file",
	} {
		if got := ParseAPIKey(xml); got != "" {
			t.Errorf("%s: invented a key %q", name, got)
		}
	}
}
