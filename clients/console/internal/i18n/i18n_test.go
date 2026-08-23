package i18n

import (
	"sort"
	"strings"
	"testing"
)

// TestEveryLocaleCarriesEveryKey is the test that keeps a translation honest.
//
// A catalog missing a key degrades to English silently, which is exactly the
// failure nobody notices until a Spanish-speaking operator reports "half the
// screen is in English" — and by then the missing keys are spread across nine
// views.
func TestEveryLocaleCarriesEveryKey(t *testing.T) {
	base := Catalog(Default)
	if len(base) == 0 {
		t.Fatal("the default catalog is empty — the embed did not load")
	}
	for _, loc := range Locales {
		entries := Catalog(loc.Code)
		if len(entries) == 0 {
			t.Fatalf("%s carries no strings", loc.Code)
		}
		for key := range base {
			if _, ok := entries[key]; !ok {
				t.Errorf("%s is missing %q", loc.Code, key)
			}
		}
		for key := range entries {
			if _, ok := base[key]; !ok {
				t.Errorf("%s defines %q, which %s does not — a stale key", loc.Code, key, Default)
			}
		}
	}
}

// TestFormatVerbsAgreeAcrossLocales catches the crash a translator cannot see.
//
// A Spanish string that drops a %d renders "%!d(MISSING)" in the middle of a
// pane, and one that adds an extra prints "%!(EXTRA int=3)". Neither fails at
// build time and neither is visible until that panel happens to be on screen.
func TestFormatVerbsAgreeAcrossLocales(t *testing.T) {
	base := Catalog(Default)
	for _, loc := range Locales {
		if loc.Code == Default {
			continue
		}
		for key, translated := range Catalog(loc.Code) {
			want, got := verbsOf(base[key]), verbsOf(translated)
			if strings.Join(want, "") != strings.Join(got, "") {
				t.Errorf("%s %q interpolates %v, but %s interpolates %v",
					loc.Code, key, got, Default, want)
			}
		}
	}
}

// verbsOf lists a format string's verbs, sorted, ignoring argument indexes.
//
// Sorted because a translation is allowed to REORDER what it interpolates —
// "hace 3m" against "3m ago" is the whole reason these are format strings — so
// what has to match is the set of values consumed, not the sequence.
func verbsOf(format string) []string {
	out := []string{}
	for i := 0; i < len(format); i++ {
		if format[i] != '%' {
			continue
		}
		i++
		if i >= len(format) || format[i] == '%' {
			continue // an escaped percent consumes nothing
		}
		// Skip flags, width, precision and any explicit argument index.
		for i < len(format) && strings.ContainsRune("+-# 0123456789.[]", rune(format[i])) {
			i++
		}
		if i < len(format) {
			out = append(out, string(format[i]))
		}
	}
	sort.Strings(out)
	return out
}

// TestPluralFormsComeInPairs guards the other half of N().
func TestPluralFormsComeInPairs(t *testing.T) {
	for _, loc := range Locales {
		entries := Catalog(loc.Code)
		for key := range entries {
			stem, form, found := strings.Cut(key, ".one")
			if !found || form != "" {
				continue
			}
			if _, ok := entries[stem+".other"]; !ok {
				t.Errorf("%s has %q but no plural form", loc.Code, key)
			}
		}
	}
}

func TestNChoosesTheRightForm(t *testing.T) {
	defer Use(Default)
	Use(Default)
	if got := N("layout.more", 1); !strings.Contains(got, "1 more line —") {
		t.Errorf("one line should read singular, got %q", got)
	}
	if got := N("layout.more", 4); !strings.Contains(got, "4 more lines") {
		t.Errorf("four lines should read plural, got %q", got)
	}
	Use("es-PR")
	if got := N("layout.more", 1); !strings.Contains(got, "1 línea más") {
		t.Errorf("Spanish singular, got %q", got)
	}
	if got := N("layout.more", 4); !strings.Contains(got, "4 líneas más") {
		t.Errorf("Spanish plural, got %q", got)
	}
}

func TestMatchAcceptsTheFormsPeopleActuallyUse(t *testing.T) {
	cases := map[string]string{
		"es-PR":       "es-PR",
		"es_PR.UTF-8": "es-PR",
		"ES-pr":       "es-PR",
		"es":          "es-PR", // language-only
		"es-MX":       "es-PR", // no es-MX catalog; Spanish beats English
		"en":          "en-US",
		"en_US.UTF-8": "en-US",
		"C":           "",
		"POSIX":       "",
		"":            "",
		"fr-FR":       "",
		"klingon":     "",
		"  es-pr  ":   "es-PR",
		"es-PR@euro":  "es-PR",
	}
	for in, want := range cases {
		if got := Match(in); got != want {
			t.Errorf("Match(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestDetectPrefersTheMoreDeliberateChoice pins the precedence order.
func TestDetectPrefersTheMoreDeliberateChoice(t *testing.T) {
	t.Setenv("UTCONSOLE_LOCALE", "")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "es_PR.UTF-8")

	// The environment decides when nothing more specific was said.
	if got := Detect("", ""); got != "es-PR" {
		t.Errorf("LANG should be honoured, got %q", got)
	}
	// A stored preference beats the environment's LANG...
	if got := Detect("", "en-US"); got != "en-US" {
		t.Errorf("the stored locale should beat LANG, got %q", got)
	}
	// ...and the flag beats everything.
	if got := Detect("es-PR", "en-US"); got != "es-PR" {
		t.Errorf("the flag should win, got %q", got)
	}
	// An unusable preference falls through rather than failing.
	if got := Detect("klingon", ""); got != "es-PR" {
		t.Errorf("an unknown flag value should fall through to LANG, got %q", got)
	}

	t.Setenv("LANG", "C")
	if got := Detect("", ""); got != Default {
		t.Errorf("a POSIX locale means no preference, got %q", got)
	}
}

func TestUnknownKeysStayVisible(t *testing.T) {
	defer Use(Default)
	Use("es-PR")
	// A key with no entry anywhere renders as itself: an operator can report
	// "panel.nope appeared on my screen", where a blank box says nothing.
	if got := T("panel.nope"); got != "panel.nope" {
		t.Errorf("an unknown key should render as itself, got %q", got)
	}
	// Enum leaves the server's own vocabulary alone when it does not know it.
	if got := Enum("state.torrent", "exotic_new_state"); got != "exotic_new_state" {
		t.Errorf("an unknown enum value must survive verbatim, got %q", got)
	}
	if got := Enum("state.torrent", "seeding"); got != "compartiendo" {
		t.Errorf("a known enum value should translate, got %q", got)
	}
}

func TestUseFallsBackRatherThanFailing(t *testing.T) {
	defer Use(Default)
	if got := Use("fr-FR"); got != Default {
		t.Errorf("an uncarried language should fall back to %s, got %q", Default, got)
	}
	if Current() != Default {
		t.Errorf("Current() = %q after a failed Use", Current())
	}
	if got := Use("es"); got != "es-PR" {
		t.Errorf("Use(es) = %q", got)
	}
	if CurrentName() != "Español" {
		t.Errorf("CurrentName() = %q", CurrentName())
	}
}

func TestNextCyclesTheCarriedLanguages(t *testing.T) {
	defer Use(Default)
	Use(Default)
	first := Next()
	Use(first)
	if Next() != Default {
		t.Errorf("two languages must cycle back: %s -> %s -> %s", Default, first, Next())
	}
}
