package ui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/ultratorrent/utconsole/internal/api"
)

// View renders the whole screen.
//
// Three fixed regions — a header rail, a tab rail, and a pane grid — so the
// chrome never moves and only the instruments inside it change.
func (m Model) View() string {
	if m.quitting {
		return ""
	}
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString("\n")
	b.WriteString(m.tabs())
	b.WriteString("\n")
	if m.warning != "" {
		b.WriteString(panelSeverity("Notice", styleWarn.Render(m.warning), m.contentWidth(), api.SeverityWarning))
		b.WriteString("\n")
	}
	b.WriteString(m.body())
	b.WriteString("\n")
	b.WriteString(m.footer())
	/*
	 * The console must never scroll. A terminal that scrolls loses the header
	 * and the tab rail off the top — the two things that tell an operator where
	 * they are — and no amount of correct content makes up for that.
	 */
	return clipHeight(b.String(), m.height)
}

// bodyHeight is how many rows the panes may use, after the fixed chrome.
//
// Chrome is the header rail, the tab rail, the footer and its key hints, plus a
// blank line. Budgeted rather than measured so a view can plan its lists before
// rendering them, instead of being cut afterwards.
func (m Model) bodyHeight() int {
	n := m.height - 4
	if m.warning != "" {
		n -= 3
	}
	if n < 6 {
		return 6
	}
	return n
}

// contentWidth is the drawable width, with a floor so panes never collapse.
func (m Model) contentWidth() int {
	w := m.width
	if w < 60 {
		return 60
	}
	return w
}

// header is the top rail: who, where, and whether the stream is alive.
func (m Model) header() string {
	w := m.contentWidth()
	product := styleHeaderName.Render(" UltraTorrent Console ")

	build := m.caps.Server.Product + " " + m.caps.Server.Version
	who := m.caps.User.Username
	if len(m.caps.User.Roles) > 0 {
		who += " · " + strings.Join(m.caps.User.Roles, ",")
	}
	right := styleHeaderMeta.Render(build + "  " + who + "  " + m.stream.statusText() + " ")

	gap := w - lipgloss.Width(product) - lipgloss.Width(right)
	if gap < 0 {
		// Too narrow for both: the identity matters more than the build string.
		return styleHeaderBar.Width(w).Render(fit(product, w))
	}
	return styleHeaderBar.Width(w).Render(product + strings.Repeat(" ", gap) + right)
}

// tabs is the view rail, drawn as connected segments rather than words.
func (m Model) tabs() string {
	parts := make([]string, 0, len(views))
	for i, v := range views {
		label := fmt.Sprintf(" %d %s ", i+1, v.Title)
		switch {
		case !m.viewPermitted(v):
			// Rendered, not hidden: an operator should see that a view exists
			// and ask for access rather than wonder whether this is broken.
			parts = append(parts, styleTabDenied.Render(label+"⃠"))
		case i == m.active:
			parts = append(parts, styleTabActive.Render(label))
		default:
			parts = append(parts, styleTabIdle.Render(label))
		}
	}
	rail := lipgloss.JoinHorizontal(lipgloss.Top, parts...)
	return fit(rail, m.contentWidth())
}

// footer is the status rail: freshness on the left, keys on the right.
func (m Model) footer() string {
	w := m.contentWidth()
	left := m.statusLine()
	right := styleMuted.Render("tab/1-9 view · r refresh · p pause · f filter · q quit")
	gap := w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return fit(left, w)
	}
	return left + strings.Repeat(" ", gap) + right
}

func (m Model) body() string {
	// The stream is fed by the socket, so it renders before any snapshot has
	// arrived — and keeps rendering if the REST side is failing.
	if views[m.active].Key == "stream" {
		return m.viewStream()
	}
	if m.snapshot == nil {
		if m.lastErr != nil {
			return styleErr.Render(fmt.Sprintf("Could not reach the server: %v", m.lastErr))
		}
		return styleMuted.Render("Loading…")
	}
	switch views[m.active].Key {
	case "overview":
		return m.viewOverview()
	case "torrents":
		return m.viewTorrents()
	case "media":
		return m.viewMedia()
	case "jobs":
		return m.viewJobs()
	case "acquisition":
		return m.viewAcquisition()
	case "infra":
		return m.viewInfra()
	case "activity":
		return m.viewActivity()
	case "alerts":
		return m.viewAlerts()
	case "stream":
		return m.viewStream()
	}
	return ""
}

// section renders one domain as a titled pane of a given width.
//
// Every panel goes through here so an absent one always explains itself inside
// its own frame. A blank space where data should be is the one thing an
// observability client must never show — and an empty BOX is worse than no box,
// so the reason goes where the data would have been.
func section[T any](title string, d *api.Domain[T], width int, render func(T) string) string {
	switch {
	case d == nil:
		return panel(title, styleMuted.Render("Not requested."), width)
	case !d.Available:
		body := styleMuted.Render(unavailableReason(d.Reason, d.Message))
		if d.Reason == "forbidden" {
			// A pane the account may not read is dimmed rather than alarming:
			// it is not a fault, and colouring it like one trains an operator
			// to ignore the colour that means something is wrong.
			return panelWithAccent(title+" ⃠", body, width, styleMuted, styleMuted)
		}
		return panelWithAccent(title, body, width, styleWarn, styleWarn)
	default:
		return panel(title, render(d.Data), width)
	}
}

func kv(key, value string) string {
	return styleKey.Render(pad(key, 16)) + value
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

func (m Model) viewOverview() string {
	d := m.snapshot.Domains
	w := m.contentWidth()

	/*
	 * Two columns where there is room, one where there is not. The pairing is
	 * deliberate: the left column is the host (what it is running on), the
	 * right is the work (what it is doing), so an operator answering "is the
	 * machine sick or is the workload sick" reads one side, not both.
	 */
	cols := splitWidth(w, 2, 1)
	if cols == nil {
		return rows(
			section("System", d.System, w, m.renderSystem),
			section("Storage", d.Storage, w, m.renderStorage),
			section("Transfers", d.Torrents, w, m.renderTransfers),
			section("Work", d.Jobs, w, m.renderWork),
			m.alertsPane(w, 4),
		)
	}
	left, right := cols[0], cols[1]
	return rows(
		columns(1,
			section("System", d.System, left, m.renderSystem),
			section("Transfers", d.Torrents, right, m.renderTransfers),
		),
		columns(1,
			section("Storage", d.Storage, left, m.renderStorage),
			section("Work", d.Jobs, right, m.renderWork),
		),
		m.alertsPane(w, 4),
	)
}

func (m Model) renderSystem(s api.System) string {
	load := "—"
	if len(s.LoadAverage) > 0 {
		load = fmt.Sprintf("%.2f", s.LoadAverage[0])
		if s.CPUCount > 0 {
			// Per-core, because a raw load average means nothing without
			// knowing how many cores it is spread across.
			pc := s.LoadAverage[0] / float64(s.CPUCount)
			style := styleOK
			if pc >= 4 {
				style = styleErr
			} else if pc >= 1.5 {
				style = styleWarn
			}
			load += style.Render(fmt.Sprintf("  %.2f/core", pc)) +
				styleMuted.Render(fmt.Sprintf(" (%d cores)", s.CPUCount))
		}
	}
	return strings.Join([]string{
		kv("Uptime", humanDuration(time.Duration(s.UptimeSeconds)*time.Second)),
		kv("Load", load),
		kv("Memory", humanBytes(s.MemoryBytes)),
		kv("Database", healthStyle(s.Database).Render(healthMark(s.Database)+" "+string(s.Database))),
	}, "\n")
}

func (m Model) renderStorage(s api.Storage) string {
	if len(s.Roots) == 0 {
		return styleMuted.Render("No roots reported.")
	}
	lines := make([]string, 0, len(s.Roots))
	for _, r := range s.Roots {
		mark := healthStyle(r.Health).Render(healthMark(r.Health))
		if r.UsedPercent == nil {
			lines = append(lines, mark+" "+pad(r.Path, 20)+styleMuted.Render("could not be measured"))
			continue
		}
		lines = append(lines, fmt.Sprintf("%s %s %s %s",
			mark,
			pad(truncate(r.Path, 18), 19),
			meterFor(*r.UsedPercent/100, 10),
			styleMuted.Render(humanBytes(r.FreeBytes)+" free"),
		))
	}
	return strings.Join(lines, "\n")
}

func (m Model) renderTransfers(t api.Torrents) string {
	observed := ""
	if t.ObservedAt != nil {
		// The console says how old this is because it genuinely is old: the
		// server reads its poller's last look rather than asking the engines.
		observed = styleMuted.Render("  observed " + ago(t.ObservedAt))
	}
	return strings.Join([]string{
		kv("Rates", styleAccent.Render("↓ "+humanBytes(t.Rates.DownloadRate)+"/s")+"  "+
			styleOK.Render("↑ "+humanBytes(t.Rates.UploadRate)+"/s")+observed),
		kv("Torrents", fmt.Sprintf("%d total · %d down · %d seed",
			t.Counts.Total, t.Counts.Downloading, t.Counts.Seeding)),
		kv("Attention", attentionSummary(t.Counts)),
		kv("Lifetime", fmt.Sprintf("↓ %s · ↑ %s · %.2f",
			humanBytes(t.Rates.TotalDownloaded), humanBytes(t.Rates.TotalUploaded), t.Rates.Ratio)),
	}, "\n")
}

func (m Model) renderWork(j api.Jobs) string {
	failed := fmt.Sprintf("%d", j.Failed)
	if j.Failed > 0 {
		failed = styleErr.Render(failed)
	}
	rate := "—"
	if j.SuccessRate != nil {
		rate = fmt.Sprintf("%.0f%%", *j.SuccessRate)
	}
	return strings.Join([]string{
		kv("Running", fmt.Sprintf("%d", j.Running)),
		kv("Queued", fmt.Sprintf("%d", j.Queued)),
		kv("Failed", failed),
		kv("Today", fmt.Sprintf("%d done · %d failed · %s ok", j.CompletedToday, j.FailedToday, rate)),
	}, "\n")
}

// warnIf and errIf render a count, coloured only when it is worth looking at.
//
// A zero stays plain: colouring every number trains the eye to ignore colour,
// which is the one thing that has to keep working on a dashboard.
func warnIf(n int) string {
	if n > 0 {
		return styleWarn.Render(fmt.Sprintf("%d", n))
	}
	return "0"
}

func errIf(n int) string {
	if n > 0 {
		return styleErr.Render(fmt.Sprintf("%d", n))
	}
	return "0"
}

func attentionSummary(c api.TorrentCounts) string {
	parts := make([]string, 0, 3)
	if c.Errored > 0 {
		parts = append(parts, styleErr.Render(fmt.Sprintf("%d errored", c.Errored)))
	}
	if c.Stalled > 0 {
		parts = append(parts, styleWarn.Render(fmt.Sprintf("%d stalled", c.Stalled)))
	}
	if c.Parked > 0 {
		parts = append(parts, styleMuted.Render(fmt.Sprintf("%d parked", c.Parked)))
	}
	if len(parts) == 0 {
		return styleOK.Render("nothing")
	}
	return strings.Join(parts, " · ")
}

// ---------------------------------------------------------------------------
// Torrents
// ---------------------------------------------------------------------------

func (m Model) viewTorrents() string {
	d := m.snapshot.Domains
	w := m.contentWidth()
	/*
	 * Three panes share the height. Attention is given its own share first
	 * because it is the reason to open this view at all; Active takes what is
	 * left, and the Queue a fixed slice. Each pane caps its own content, so all
	 * three keep their frames instead of the last one being cut in half.
	 */
	budget := m.bodyHeight() - 9 // three frames + titles
	attnRows, queueRows := budget/4, budget/5
	activeRows := budget - attnRows - queueRows
	return rows(
		section("Needs attention", d.Torrents, w, func(t api.Torrents) string {
			if len(t.Attention) == 0 {
				return styleOK.Render("Nothing errored or stalled.")
			}
			return capBody(m.torrentTable(t.Attention, w-4), attnRows)
		}),
		section("Active", d.Torrents, w, func(t api.Torrents) string {
			if len(t.Active) == 0 {
				return styleMuted.Render("Nothing transferring.")
			}
			out := capBody(m.torrentTable(t.Active, w-4), activeRows)
			if t.Truncated {
				// Never a silent cut: a list that quietly stops at 25 reads as
				// "that is all of them".
				out += "\n" + styleMuted.Render("… capped by the server; not the full list.")
			}
			return out
		}),
		section("Queue", d.Queue, w, func(q api.Queue) string {
			if len(q.Entries) == 0 {
				return styleMuted.Render("The scheduler has no pending decisions.")
			}
			lines := make([]string, 0, len(q.Entries)+1)
			lines = append(lines, styleColHead.Render(
				pad("TORRENT", w-46)+pad("NOW", 13)+pad("WANTED", 13)+"WHY"))
			for _, e := range q.Entries {
				want := styleMuted.Render(pad("—", 13))
				if e.DesiredState != nil {
					// A desired state that differs from the current one is the
					// whole point of the row: it is what the scheduler is about
					// to do, and the reason it has not yet.
					want = styleAccent.Render(pad(*e.DesiredState, 13))
				}
				reason := ""
				if e.Reason != nil {
					reason = styleMuted.Render(truncate(*e.Reason, 24))
				}
				name := e.Name
				if e.ProtectedFromRemoval {
					name = "🔒 " + name
				}
				lines = append(lines, pad(truncate(name, w-48), w-46)+
					pad(e.CurrentState, 13)+want+reason)
			}
			return capBody(strings.Join(lines, "\n"), queueRows)
		}),
	)
}

// torrentTable lays out rows against an inner pane width.
func (m Model) torrentTable(list []api.Torrent, inner int) string {
	const fixed = 12 + 12 + 11 + 11 + 8 + 5 // state, prog, down, up, eta, gaps
	nameW := inner - fixed
	if nameW < 16 {
		nameW = 16
	}
	head := styleColHead.Render(
		pad("NAME", nameW) + " " + pad("STATE", 12) + " " + padLeft("PROGRESS", 11) + " " +
			padLeft("DOWN", 11) + " " + padLeft("UP", 11) + " " + padLeft("ETA", 8),
	)
	lines := make([]string, 0, len(list)+1)
	lines = append(lines, head)
	for _, t := range list {
		state := t.State
		if t.Stalled {
			state = "stalled"
		}
		if t.Parked {
			state += "·parked"
		}
		lines = append(lines, strings.Join([]string{
			pad(t.Name, nameW),
			torrentStateStyle(t.State, t.Stalled).Render(pad(state, 12)),
			padLeft(progressMeter(t.Progress, 5)+fmt.Sprintf(" %3.0f%%", t.Progress*100), 11),
			styleAccent.Render(padLeft(humanRate(t.DownloadRate), 11)),
			styleOK.Render(padLeft(humanRate(t.UploadRate), 11)),
			styleMuted.Render(padLeft(humanETA(t.ETA), 8)),
		}, " "))
	}
	return strings.Join(lines, "\n")
}

func (m Model) viewMedia() string {
	d := m.snapshot.Domains
	w := m.contentWidth()
	cols := splitWidth(w, 2, 1)

	library := section("Library", d.Media, colOr(cols, 0, w), func(md api.Media) string {
		types := make([]string, 0, len(md.ByType))
		for k, v := range md.ByType {
			types = append(types, fmt.Sprintf("%d %s", v, k))
		}
		sort.Strings(types)
		return strings.Join([]string{
			kv("Items", fmt.Sprintf("%d", md.TotalItems)),
			kv("By type", strings.Join(types, " · ")),
			kv("Unmatched", warnIf(md.Unmatched)),
			kv("Low confidence", warnIf(md.LowConfidence)),
		}, "\n")
	})
	playing := section("Playing now", d.Playback, colOr(cols, 1, w), func(p api.Playback) string {
		if len(p.Sessions) == 0 {
			return styleMuted.Render("Nobody is watching anything.")
		}
		lines := make([]string, 0, len(p.Sessions))
		for _, sess := range p.Sessions {
			method := "direct"
			style := styleOK
			if sess.PlaybackMethod != nil {
				method = *sess.PlaybackMethod
				if strings.Contains(strings.ToLower(method), "transcode") {
					style = styleWarn
				}
			}
			title := sess.Title
			if sess.ShowTitle != nil && *sess.ShowTitle != "" {
				title = *sess.ShowTitle + " · " + title
			}
			progress := 0.0
			if sess.ProgressPercent != nil {
				progress = *sess.ProgressPercent / 100
			}
			lines = append(lines, fmt.Sprintf("%s %s %s %s",
				pad(truncate(title, 24), 26),
				pad(orDash(sess.Viewer), 12),
				style.Render(pad(truncate(method, 10), 11)),
				progressMeter(progress, 8)))
		}
		return strings.Join(lines, "\n")
	})

	intakeRows := m.bodyHeight() - 12 // the library/playback row plus frames
	intake := section("Intake", d.MediaIntake, w, func(mi api.MediaIntake) string {
		lines := []string{
			kv("Active", fmt.Sprintf("%d", mi.Active)) + "   " +
				kv("Failed", errIf(mi.Failed)) + "   " +
				kv("Quarantined", warnIf(mi.Quarantined)) + "   " +
				kv("Imported today", fmt.Sprintf("%d", mi.ImportedToday)),
		}
		if len(mi.Recent) > 0 {
			lines = append(lines, "", styleColHead.Render(pad("RELEASE", w-42)+pad("STATE", 16)+"UPDATED"))
			for _, j := range mi.Recent {
				state := j.State
				style := styleBase
				switch j.State {
				case "failed":
					style = styleErr
				case "quarantined":
					style = styleWarn
				}
				lines = append(lines, pad(truncate(j.SourceName, w-44), w-42)+
					style.Render(pad(state, 16))+styleMuted.Render(ago(&j.UpdatedAt)))
				if j.LastError != nil && *j.LastError != "" {
					lines = append(lines, styleErr.Render("  ↳ "+truncate(*j.LastError, w-10)))
				}
			}
		}
		return capBody(strings.Join(lines, "\n"), intakeRows)
	})

	if cols == nil {
		return rows(library, playing, intake)
	}
	return rows(columns(1, library, playing), intake)
}

func (m Model) viewJobs() string {
	d := m.snapshot.Domains
	w := m.contentWidth()
	budget := m.bodyHeight() - 6
	jobRows := budget * 2 / 3
	autoRows := budget - jobRows
	return rows(
		section("Jobs", d.Jobs, w, func(j api.Jobs) string {
			rate := "—"
			if j.SuccessRate != nil {
				rate = fmt.Sprintf("%.0f%%", *j.SuccessRate)
			}
			lines := []string{
				kv("Running", fmt.Sprintf("%d", j.Running)) + "   " +
					kv("Queued", fmt.Sprintf("%d", j.Queued)) + "   " +
					kv("Failed", errIf(j.Failed)) + "   " +
					kv("Success today", rate),
			}
			if len(j.Recent) > 0 {
				lines = append(lines, "", styleColHead.Render(
					pad("TYPE", w-46)+pad("STATUS", 18)+pad("PROG", 7)+"WHEN"))
				for _, job := range j.Recent {
					prog := "—"
					if job.Progress != nil {
						prog = fmt.Sprintf("%d%%", *job.Progress)
					}
					style := styleBase
					switch job.Status {
					case "failed":
						style = styleErr
					case "stalled":
						style = styleWarn
					}
					// The most recent thing that happened to it: finished, else
					// started, else created. "When" on a job means its last move.
					when := job.CreatedAt
					if job.StartedAt != nil {
						when = *job.StartedAt
					}
					if job.CompletedAt != nil {
						when = *job.CompletedAt
					}
					line := pad(truncate(job.Type, w-48), w-46) + style.Render(pad(job.Status, 18)) +
						pad(prog, 7) + styleMuted.Render(ago(&when))
					if job.ErrorCode != nil {
						line += styleErr.Render("  " + *job.ErrorCode)
					}
					lines = append(lines, line)
				}
			}
			return capBody(strings.Join(lines, "\n"), jobRows)
		}),
		section("Automation", d.Automation, w, func(a api.Automation) string {
			lines := []string{
				kv("Rules", fmt.Sprintf("%d", len(a.Rules))) + "   " +
					kv("Failures (24h)", errIf(a.Failures24h)),
			}
			for _, r := range a.RecentRuns {
				style := styleOK
				if r.Status != "success" {
					style = styleWarn
				}
				line := pad(truncate(r.RuleName, 34), 36) + style.Render(pad(r.Status, 14)) +
					styleMuted.Render(ago(&r.At))
				if r.Message != nil && *r.Message != "" && r.Status != "success" {
					line += styleMuted.Render("  " + truncate(*r.Message, 30))
				}
				lines = append(lines, line)
			}
			return capBody(strings.Join(lines, "\n"), autoRows)
		}),
	)
}

func (m Model) viewAcquisition() string {
	w := m.contentWidth()
	d := m.snapshot.Domains
	cols := splitWidth(w, 2, 1)
	paneRows := m.bodyHeight() - 3
	if cols == nil {
		// Stacked, so they share rather than each taking the full height.
		paneRows = (m.bodyHeight() - 6) / 2
	}

	feeds := section("Feeds", d.Acquisition, colOr(cols, 0, w), func(a api.Acquisition) string {
		lines := []string{kv("Grabs (24h)", fmt.Sprintf("%d", a.Grabs24h)), ""}
		lines = append(lines, styleColHead.Render(pad("FEED", 22)+pad("RULES", 7)+pad("POLLED", 12)+"STATE"))
		for _, f := range a.Feeds {
			state := styleOK.Render("ok")
			if !f.Enabled {
				state = styleMuted.Render("disabled")
			} else if overdue(f.LastPolledAt, f.RefreshIntervalSeconds) {
				// Staleness against the feed's own interval is the only health
				// signal available: RSS poll failures are logged, never stored.
				state = styleWarn.Render("overdue")
			}
			lines = append(lines, pad(truncate(f.Name, 20), 22)+
				pad(fmt.Sprintf("%d", f.RuleCount), 7)+
				pad(ago(f.LastPolledAt), 12)+state)
		}
		return capBody(strings.Join(lines, "\n"), paneRows)
	})

	recent := section("Recent releases", d.Acquisition, colOr(cols, 1, w), func(a api.Acquisition) string {
		if len(a.Recent) == 0 {
			return styleMuted.Render("Nothing seen yet.")
		}
		lines := make([]string, 0, len(a.Recent))
		for _, e := range a.Recent {
			style := styleMuted
			switch e.Result {
			case "downloaded":
				style = styleOK
			case "matched":
				// "A rule wanted this and it was not taken" — the state worth
				// attention, which is why the contract keeps it distinct from a
				// plain rejection.
				style = styleWarn
			}
			lines = append(lines, pad(truncate(e.ReleaseTitle, 34), 36)+style.Render(pad(e.Result, 18)))
		}
		return capBody(strings.Join(lines, "\n"), paneRows)
	})

	if cols == nil {
		return rows(feeds, recent)
	}
	return columns(1, feeds, recent)
}

func (m Model) viewInfra() string {
	d := m.snapshot.Domains
	w := m.contentWidth()
	cols := splitWidth(w, 2, 1)

	infraRows := (m.bodyHeight() - 9) / 2
	engines := section("Engines", d.Engines, colOr(cols, 0, w), func(list []api.Engine) string {
		if len(list) == 0 {
			return styleMuted.Render("No engines configured.")
		}
		lines := make([]string, 0, len(list))
		for _, e := range list {
			count := "—"
			if e.TorrentCount != nil {
				count = fmt.Sprintf("%d", *e.TorrentCount)
			}
			lines = append(lines, healthStyle(e.Health).Render(healthMark(e.Health))+" "+
				pad(truncate(e.EngineID, 18), 20)+pad(e.Kind, 13)+padLeft(count, 6)+
				styleMuted.Render("  "+ago(e.LastSeenAt)))
			if e.Error != nil {
				lines = append(lines, styleErr.Render("  ↳ "+truncate(*e.Error, 40)))
			}
		}
		return capBody(strings.Join(lines, "\n"), infraRows)
	})

	indexers := section("Indexers", d.Indexers, colOr(cols, 1, w), func(list []api.Indexer) string {
		if len(list) == 0 {
			return styleMuted.Render("No indexers configured.")
		}
		lines := make([]string, 0, len(list))
		for _, i := range list {
			lines = append(lines, healthStyle(i.Health).Render(healthMark(i.Health))+" "+
				pad(truncate(i.Name, 20), 22)+pad(i.Protocol, 10)+styleMuted.Render(ago(i.LastTestedAt)))
			if i.Message != nil && i.Health != api.HealthHealthy {
				lines = append(lines, styleWarn.Render("  ↳ "+truncate(*i.Message, 40)))
			}
		}
		return capBody(strings.Join(lines, "\n"), infraRows)
	})

	providers := section("Providers", d.Providers, w, func(list []api.Provider) string {
		if len(list) == 0 {
			return styleMuted.Render("No providers configured.")
		}
		lines := make([]string, 0, len(list))
		for _, p := range list {
			line := healthStyle(p.Health).Render(healthMark(p.Health)) + " " +
				pad(truncate(p.Name, 24), 26) + pad(p.Category, 16) +
				styleMuted.Render("checked "+ago(p.LastCheckedAt))
			if p.Message != nil && p.Health != api.HealthHealthy {
				line += styleWarn.Render("  ↳ " + truncate(*p.Message, w-60))
			}
			lines = append(lines, line)
		}
		return capBody(strings.Join(lines, "\n"), infraRows)
	})

	if cols == nil {
		return rows(engines, indexers, providers)
	}
	return rows(columns(1, engines, indexers), providers)
}

func (m Model) viewActivity() string {
	d := m.snapshot.Domains
	w := m.contentWidth()
	activityRows := m.bodyHeight() - 8
	return rows(
		section("Recent activity", d.RecentActivity, w, func(list []api.ActivityItem) string {
			if len(list) == 0 {
				return styleMuted.Render("Nothing recorded.")
			}
			lines := make([]string, 0, len(list))
			for _, a := range list {
				count := ""
				if a.EventCount > 1 {
					// The collapsed line says what it stands for. The console
					// cannot expand it — the snapshot carries a count, not the
					// constituents — and pretending otherwise would be a lie.
					count = styleMuted.Render(fmt.Sprintf("  (%d events)", a.EventCount))
				}
				lines = append(lines, styleMuted.Render(pad(ago(&a.At), 12))+
					levelStyle(a.Level).Render(truncate(a.Message, w-24))+count)
				if a.Detail != nil && *a.Detail != "" {
					lines = append(lines, styleMuted.Render("             ↳ "+truncate(*a.Detail, w-20)))
				}
			}
			return capBody(strings.Join(lines, "\n"), activityRows)
		}),
		section("Notifications", d.Notifications, w, func(n api.Notifications) string {
			return kv("Pending", fmt.Sprintf("%d", n.Pending)) + "   " +
				kv("Failed (24h)", errIf(n.Failed24h))
		}),
	)
}

func (m Model) viewAlerts() string { return m.alertsPane(m.contentWidth(), 0) }

// alertsPane renders the attention list; limit 0 means all of them.
func (m Model) alertsPane(width, limit int) string {
	d := m.snapshot.Domains.Alerts

	// The frame carries the worst severity present, so a critical alert is
	// visible as a red box before a word of it has been read.
	worst := api.SeverityInfo
	if d != nil && d.Available {
		for _, a := range d.Data {
			if severityRank(a.Severity) < severityRank(worst) {
				worst = a.Severity
			}
		}
	}

	body := func(list []api.Alert) string {
		if len(list) == 0 {
			return styleOK.Render("Nothing needs attention.")
		}
		shown := list
		if limit > 0 && len(shown) > limit {
			shown = shown[:limit]
		}
		lines := make([]string, 0, len(shown)+2)
		for _, a := range shown {
			style := severityStyle(a.Severity)
			line := style.Render(severityMark(a.Severity)+" "+truncate(a.Title, width-24)) +
				styleMuted.Render("  ["+a.Domain+"]")
			if a.Since != nil {
				line += styleMuted.Render(" since " + ago(a.Since))
			}
			lines = append(lines, line)
			if a.Detail != nil && *a.Detail != "" {
				lines = append(lines, styleMuted.Render("  ↳ "+truncate(*a.Detail, width-8)))
			}
		}
		if limit > 0 && len(list) > limit {
			lines = append(lines, styleMuted.Render(fmt.Sprintf("… and %d more (press 8)", len(list)-limit)))
		}
		/*
		 * Not repeated on screen, but true and worth stating once here: these
		 * are computed from current state each time a snapshot is built. They
		 * cannot be acknowledged, and the way to make one go away is to fix what
		 * it reports — which is why there is no dismiss key.
		 */
		return strings.Join(lines, "\n")
	}

	if d == nil || !d.Available || len(d.Data) == 0 {
		return section("Attention", d, width, body)
	}
	return panelSeverity("Attention", body(d.Data), width, worst)
}

// severityRank orders severities most-severe-first.
func severityRank(s api.Severity) int {
	switch s {
	case api.SeverityCritical:
		return 0
	case api.SeverityError:
		return 1
	case api.SeverityWarning:
		return 2
	default:
		return 3
	}
}

// colOr returns the nth column width, or the full width when not gridded.
func colOr(cols []int, n, full int) int {
	if cols == nil || n >= len(cols) {
		return full
	}
	return cols[n]
}

// overdue reports a feed that has missed more than one poll window.
//
// Twice the interval, not once: a poll landing a moment late is normal, and
// flagging that would make "overdue" meaningless.
func overdue(last *string, intervalSeconds int) bool {
	if last == nil || *last == "" || intervalSeconds <= 0 {
		return false
	}
	t, err := time.Parse(time.RFC3339, *last)
	if err != nil {
		return false
	}
	return time.Since(t) > 2*time.Duration(intervalSeconds)*time.Second
}

// orDash renders an optional string, or an em dash when the server had none.
func orDash(v *string) string {
	if v == nil || *v == "" {
		return "—"
	}
	return *v
}
