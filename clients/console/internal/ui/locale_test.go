package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/i18n"
)

// Translation moves the one property this UI cannot get wrong.
//
// Every label on screen is padded into a fixed-width column, and Spanish is
// reliably longer than English — "Almacenamiento" against "Storage",
// "Infraestructura" against "Infrastructure". A pane that overflows wraps, and
// a wrapped border tears every box below it. So the width and height properties
// are re-asserted in each language rather than trusted to hold because they
// held in English.

func TestEveryLanguageFitsTheTerminal(t *testing.T) {
	defer i18n.Use(i18n.Default)
	for _, loc := range i18n.Locales {
		i18n.Use(loc.Code)
		for _, size := range []struct{ w, h int }{{72, 20}, {100, 24}, {120, 30}, {150, 44}, {200, 60}} {
			m := testModel(size.w)
			m.height = size.h
			for i := range views {
				m.active = i
				view := m.View()
				for n, line := range strings.Split(view, "\n") {
					if got := lipgloss.Width(line); got > size.w {
						t.Errorf("%s view %q at %dx%d: line %d is %d wide\n%q",
							loc.Code, views[i].Key, size.w, size.h, n, got, line)
					}
				}
				if got := len(strings.Split(view, "\n")); got > size.h {
					t.Errorf("%s view %q at %dx%d rendered %d lines — it will scroll",
						loc.Code, views[i].Key, size.w, size.h, got)
				}
			}
		}
	}
}

// TestNoCatalogKeyReachesTheScreen catches the failure a fallback hides.
//
// A key with no entry renders as itself, which is deliberate — it is reportable
// where a blank box is not — but it must never actually happen in a shipped
// build. Rendering every view in every language and looking for the keys
// themselves is the only check that covers the strings a unit test would have
// to know to ask for.
func TestNoCatalogKeyReachesTheScreen(t *testing.T) {
	defer i18n.Use(i18n.Default)
	keys := i18n.Catalog(i18n.Default)
	for _, loc := range i18n.Locales {
		i18n.Use(loc.Code)
		m := testModel(150)
		for i := range views {
			m.active = i
			rendered := plain(m.View())
			for key := range keys {
				if strings.Contains(rendered, key) {
					t.Errorf("%s view %q rendered the key %q instead of a string",
						loc.Code, views[i].Key, key)
				}
			}
		}
	}
}

func TestSpanishActuallyReachesThePanes(t *testing.T) {
	defer i18n.Use(i18n.Default)
	i18n.Use("es-PR")
	m := testModel(150)
	m.active = 0
	rendered := plain(m.View())

	for _, want := range []string{"Resumen", "Almacenamiento", "Transferencias", "Carga"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("the overview should carry %q in Spanish:\n%s", want, rendered)
		}
	}
	// The English words those replaced must be gone, not merely accompanied:
	// a half-translated pane is the failure mode worth testing for.
	for _, gone := range []string{"Storage", "Transfers", "Uptime"} {
		if strings.Contains(rendered, gone) {
			t.Errorf("the overview still carries the English %q:\n%s", gone, rendered)
		}
	}
}

// TestServerVocabularyIsTranslatedButNeverInvented pins the Enum contract.
func TestServerVocabularyIsTranslatedButNeverInvented(t *testing.T) {
	defer i18n.Use(i18n.Default)
	i18n.Use("es-PR")
	m := testModel(150)
	m.active = 1 // torrents
	rendered := plain(m.View())
	if !strings.Contains(rendered, "compartiendo") {
		t.Errorf("a seeding torrent should read as compartiendo:\n%s", rendered)
	}

	// A state this console has never heard of survives verbatim: hiding it, or
	// rendering it as a key, would be the console lying about what the server
	// said.
	m.snapshot.Domains.Torrents.Data.Active[0].State = "warp_speed"
	if !strings.Contains(plain(m.View()), "warp_speed") {
		t.Error("an unknown state must reach the screen unchanged")
	}
}

// TestTheLanguageKeySwitchesAndPersists covers the whole gesture.
func TestTheLanguageKeySwitchesAndPersists(t *testing.T) {
	defer i18n.Use(i18n.Default)
	i18n.Use(i18n.Default)

	saved := ""
	m := testModel(150).OnLocaleChange(func(code string) { saved = code })
	if !strings.Contains(plain(m.View()), "Overview") {
		t.Fatal("the console did not start in English")
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'L'}})
	if !strings.Contains(plain(next.View()), "Resumen") {
		t.Errorf("L should have switched the language:\n%s", plain(next.View()))
	}
	if saved != "es-PR" {
		t.Errorf("the chosen language should be handed back for persistence, got %q", saved)
	}

	// And back: two languages must cycle, not dead-end.
	back, _ := next.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'L'}})
	if !strings.Contains(plain(back.View()), "Overview") {
		t.Error("a second L should return to English")
	}
	if saved != i18n.Default {
		t.Errorf("the return trip should persist too, got %q", saved)
	}
}

// TestTheKeyHintsSurviveInBothLanguages pins what the Spanish rail exposed.
//
// The hint is the only place the bindings are written down on screen. A single
// hint string is dropped whole once it no longer fits, so the longer language
// lost every binding at a width where the shorter still showed them all — a
// difference nothing else would have caught, because dropping content passes a
// width test perfectly.
func TestTheKeyHintsSurviveInBothLanguages(t *testing.T) {
	defer i18n.Use(i18n.Default)
	for _, loc := range i18n.Locales {
		i18n.Use(loc.Code)
		for _, width := range []int{100, 118, 120, 150, 200} {
			m := testModel(width)
			footer := plain(m.footer())
			if !strings.Contains(footer, "1-9") || !strings.Contains(footer, "q ") {
				t.Errorf("%s at %d columns lost its key hints:\n%q", loc.Code, width, footer)
			}
			if got := lipgloss.Width(plain(m.footer())); got > width {
				t.Errorf("%s at %d columns: the footer is %d wide", loc.Code, width, got)
			}
		}
	}
}

// TestLowercaseLStillChangesView guards the binding it shares a letter with.
func TestLowercaseLStillChangesView(t *testing.T) {
	defer i18n.Use(i18n.Default)
	i18n.Use(i18n.Default)
	m := testModel(150)
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'l'}})
	if next.(Model).active == m.active {
		t.Error("lowercase l must still move to the next view")
	}
	if i18n.Current() != i18n.Default {
		t.Errorf("lowercase l must not change the language, got %q", i18n.Current())
	}
}
