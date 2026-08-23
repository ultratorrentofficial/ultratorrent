// Package i18n is the console's string catalog.
//
// Every word an operator reads comes from here, in one of two languages the
// binary carries with it. Embedded rather than loaded from disk: this ships as
// a single static file that gets scp'd onto a headless server, and a console
// that needed a locale directory beside it would be a console that renders half
// in English the first time someone forgets to copy one.
//
// The catalogs are format strings, not sentences, so a translation may reorder
// what it interpolates ("hace 3m" against "3m ago"). Go's explicit argument
// indexes (%[2]s) are available to any translation that needs them.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Default is the language every lookup falls back to.
//
// English is the fallback rather than "the key" because a missing Spanish
// string should degrade to a sentence someone can act on, not to
// `panel.storage.empty` printed inside a box.
const Default = "en-US"

// Locale is one language this binary carries.
type Locale struct {
	// Code is the BCP-47 tag, matching the web app's own locale codes.
	Code string
	// Name is the language named in itself, which is the only naming that is
	// useful to someone who cannot read the current one.
	Name string
}

// Locales are the languages available, in the order the in-console toggle
// cycles them.
var Locales = []Locale{
	{Code: "en-US", Name: "English"},
	{Code: "es-PR", Name: "Español"},
}

//go:embed locales/*.json
var files embed.FS

var (
	mu       sync.RWMutex
	current  = Default
	catalogs = map[string]map[string]string{}
)

func init() {
	for _, loc := range Locales {
		raw, err := files.ReadFile("locales/" + loc.Code + ".json")
		if err != nil {
			continue
		}
		var entries map[string]string
		if err := json.Unmarshal(raw, &entries); err != nil {
			// A malformed catalog costs that language, never the program: the
			// console's job is to keep reporting on a machine that may be
			// having a bad day, and it must not be the thing that fails.
			continue
		}
		catalogs[loc.Code] = entries
	}
}

// Use switches the active language, returning the code actually selected.
//
// Takes anything a person or an environment might supply — "es", "es_PR.UTF-8",
// "ES-pr" — and resolves it, because a locale that has to be spelled exactly is
// a locale nobody reaches.
func Use(pref string) string {
	code := Match(pref)
	if code == "" {
		code = Default
	}
	mu.Lock()
	current = code
	mu.Unlock()
	return code
}

// Current reports the active language code.
func Current() string {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

// CurrentName reports the active language named in itself, for the header rail.
func CurrentName() string {
	code := Current()
	for _, loc := range Locales {
		if loc.Code == code {
			return loc.Name
		}
	}
	return code
}

// Next returns the language after the current one, wrapping.
//
// The console cycles rather than opening a picker: two languages do not earn a
// modal, and a modal in a read-only dashboard is one more thing that can be
// left open over the panel someone needs to read.
func Next() string {
	code := Current()
	for i, loc := range Locales {
		if loc.Code == code {
			return Locales[(i+1)%len(Locales)].Code
		}
	}
	return Default
}

// Match resolves a preference to a carried locale, or "" when none fits.
//
// Exact tag first, then the language subtag: someone running es-MX or es-ES is
// far better served by es-PR than by English, and the alternative — matching
// only es-PR — would leave every other Spanish-speaking install in English.
func Match(pref string) string {
	pref = normalize(pref)
	if pref == "" {
		return ""
	}
	for _, loc := range Locales {
		if normalize(loc.Code) == pref {
			return loc.Code
		}
	}
	lang, _, _ := strings.Cut(pref, "-")
	for _, loc := range Locales {
		if code, _, _ := strings.Cut(normalize(loc.Code), "-"); code == lang {
			return loc.Code
		}
	}
	return ""
}

// normalize turns any of the forms a locale is written in into "xx-yy".
//
// POSIX writes es_PR.UTF-8, BCP-47 writes es-PR, and people write ES. The
// modifier suffixes (@euro, .UTF-8) carry no language information.
func normalize(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" || s == "c" || s == "posix" {
		return ""
	}
	s = strings.ReplaceAll(s, "_", "-")
	if i := strings.IndexAny(s, ".@"); i >= 0 {
		s = s[:i]
	}
	return s
}

// Detect picks a language from the sources that may name one, in priority order.
//
// The flag beats the environment because it is the more deliberate act; the
// environment beats the stored preference because a locale exported for this
// session is a statement about this session. Detection lives here rather than
// in main so it can be tested without setting process-wide variables — and so
// package tests are never at the mercy of the machine's own LANG.
func Detect(flag, configured string) string {
	for _, pref := range []string{
		flag,
		os.Getenv("UTCONSOLE_LOCALE"),
		configured,
		os.Getenv("LC_ALL"),
		os.Getenv("LC_MESSAGES"),
		os.Getenv("LANG"),
	} {
		if code := Match(pref); code != "" {
			return code
		}
	}
	return Default
}

// T renders one string, interpolating any arguments printf-style.
func T(key string, args ...any) string {
	format := lookup(key)
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

// N renders a counted string, choosing the singular or plural entry.
//
// The count is passed to the format as its first argument, so a catalog entry
// reads "%d more line(s)" without the caller having to supply the number twice.
// Two forms is all these two languages need; a catalog for a language with more
// would need the rule here to grow, and deliberately does not pretend to handle
// one it does not carry.
func N(key string, n int, args ...any) string {
	form := key + ".other"
	if n == 1 || n == -1 {
		form = key + ".one"
	}
	entry, ok := find(form)
	if !ok {
		entry = lookup(key + ".other")
	}
	return fmt.Sprintf(entry, append([]any{n}, args...)...)
}

// Enum translates a value the SERVER chose, leaving anything unknown as it came.
//
// Torrent states, job statuses and health words are a vocabulary the platform
// owns and this console only displays. Translating them makes the screen
// readable; falling back to the raw value means a state added on the server
// tomorrow appears verbatim rather than vanishing or rendering as a key — the
// console must never hide something it does not recognise.
func Enum(prefix, value string) string {
	if value == "" {
		return value
	}
	if s, ok := find(prefix + "." + value); ok {
		return s
	}
	return value
}

// Has reports whether the active language defines a key. For tests and tooling.
func Has(key string) bool {
	_, ok := find(key)
	return ok
}

// Catalog returns a copy of one language's entries, for tests and tooling.
func Catalog(code string) map[string]string {
	mu.RLock()
	defer mu.RUnlock()
	out := make(map[string]string, len(catalogs[code]))
	for k, v := range catalogs[code] {
		out[k] = v
	}
	return out
}

// lookup resolves a key, degrading through English to the key itself.
func lookup(key string) string {
	if s, ok := find(key); ok {
		return s
	}
	// The key is a last resort and is deliberately ugly: an operator seeing
	// `panel.storage.title` on screen reports it, where a silent blank box is
	// the failure this whole package exists to avoid.
	return key
}

func find(key string) (string, bool) {
	mu.RLock()
	defer mu.RUnlock()
	if s, ok := catalogs[current][key]; ok && s != "" {
		return s, true
	}
	if s, ok := catalogs[Default][key]; ok && s != "" {
		return s, true
	}
	return "", false
}
