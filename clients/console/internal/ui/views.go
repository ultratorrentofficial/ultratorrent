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
func (m Model) View() string {
	if m.quitting {
		return ""
	}
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString("\n")
	b.WriteString(m.tabs())
	b.WriteString("\n\n")
	if m.warning != "" {
		b.WriteString(styleWarn.Render("⚠ "+m.warning) + "\n\n")
	}
	b.WriteString(m.body())
	b.WriteString("\n")
	b.WriteString(m.statusLine())
	b.WriteString("\n")
	b.WriteString(styleMuted.Render("tab/1-8 switch · r refresh · p pause · q quit"))
	return b.String()
}

func (m Model) header() string {
	server := m.caps.Server.Product + " " + m.caps.Server.Version
	who := m.caps.User.Username
	if len(m.caps.User.Roles) > 0 {
		who += " (" + strings.Join(m.caps.User.Roles, ", ") + ")"
	}
	left := styleTitle.Render("UltraTorrent Console")
	right := styleMuted.Render(server + " · " + who)
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return styleHeader.Width(m.width).Render(left + strings.Repeat(" ", gap) + right)
}

func (m Model) tabs() string {
	parts := make([]string, 0, len(views))
	for i, v := range views {
		label := fmt.Sprintf("%d %s", i+1, v.Title)
		switch {
		case !m.viewPermitted(v):
			// Rendered, not hidden: an operator should be able to see that a
			// view exists and ask for access, rather than wonder whether the
			// console is broken.
			parts = append(parts, styleTabDenied.Render(label+" ⃠"))
		case i == m.active:
			parts = append(parts, styleTabActive.Render(label))
		default:
			parts = append(parts, styleTabIdle.Render(label))
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, parts...)
}

func (m Model) body() string {
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
	}
	return ""
}

// section renders a titled block, or the reason it is missing.
//
// Every panel goes through here so an absent one always explains itself. A
// blank space where data should be is the one thing an observability client
// must never show.
func section[T any](title string, d *api.Domain[T], render func(T) string) string {
	head := styleTitle.Render(title)
	switch {
	case d == nil:
		return head + "\n" + stylePanel.Render(styleMuted.Render("Not requested."))
	case !d.Available:
		return head + "\n" + stylePanel.Render(styleMuted.Render(unavailableReason(d.Reason, d.Message)))
	default:
		return head + "\n" + stylePanel.Render(render(d.Data))
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
	blocks := []string{
		section("System", d.System, func(s api.System) string {
			load := "—"
			if len(s.LoadAverage) > 0 {
				load = fmt.Sprintf("%.2f", s.LoadAverage[0])
				if s.CPUCount > 0 {
					// Per-core, because a raw load average means nothing
					// without knowing how many cores it is spread across.
					pc := s.LoadAverage[0] / float64(s.CPUCount)
					style := styleOK
					if pc >= 4 {
						style = styleErr
					} else if pc >= 1.5 {
						style = styleWarn
					}
					load += style.Render(fmt.Sprintf("  (%.2f per core, %d cores)", pc, s.CPUCount))
				}
			}
			return strings.Join([]string{
				kv("Uptime", humanDuration(time.Duration(s.UptimeSeconds)*time.Second)),
				kv("Load", load),
				kv("Memory (RSS)", humanBytes(s.MemoryBytes)),
				kv("Database", healthStyle(s.Database).Render(healthMark(s.Database)+" "+string(s.Database))),
			}, "\n")
		}),
		section("Storage", d.Storage, func(s api.Storage) string {
			if len(s.Roots) == 0 {
				return styleMuted.Render("No roots reported.")
			}
			lines := make([]string, 0, len(s.Roots))
			for _, r := range s.Roots {
				if r.UsedPercent == nil {
					lines = append(lines, styleWarn.Render(healthMark(r.Health)+" ")+pad(r.Path, 28)+styleMuted.Render("could not be measured"))
					continue
				}
				lines = append(lines, fmt.Sprintf("%s %s%s %s free of %s",
					healthStyle(r.Health).Render(healthMark(r.Health)),
					pad(r.Path, 28),
					progressBar(*r.UsedPercent/100, 12),
					padLeft(humanBytes(r.FreeBytes), 9),
					humanBytes(r.TotalBytes),
				))
			}
			return strings.Join(lines, "\n")
		}),
		section("Transfers", d.Torrents, func(t api.Torrents) string {
			observed := styleMuted.Render("")
			if t.ObservedAt != nil {
				// The console says how old this is because it genuinely is old:
				// the server reads its poller's last look rather than asking the
				// engines again.
				observed = styleMuted.Render("  observed " + ago(t.ObservedAt))
			}
			return strings.Join([]string{
				kv("Rates", styleAccent.Render("↓ "+humanBytes(t.Rates.DownloadRate)+"/s")+"   "+
					styleOK.Render("↑ "+humanBytes(t.Rates.UploadRate)+"/s")+observed),
				kv("Torrents", fmt.Sprintf("%d total · %d downloading · %d seeding",
					t.Counts.Total, t.Counts.Downloading, t.Counts.Seeding)),
				kv("Needs attention", attentionSummary(t.Counts)),
				kv("Lifetime", fmt.Sprintf("↓ %s · ↑ %s · ratio %.2f",
					humanBytes(t.Rates.TotalDownloaded), humanBytes(t.Rates.TotalUploaded), t.Rates.Ratio)),
			}, "\n")
		}),
		section("Work", d.Jobs, func(j api.Jobs) string {
			failed := fmt.Sprintf("%d", j.Failed)
			if j.Failed > 0 {
				failed = styleErr.Render(failed)
			}
			return strings.Join([]string{
				kv("Jobs", fmt.Sprintf("%d running · %d queued · %s failed", j.Running, j.Queued, failed)),
				kv("Today", fmt.Sprintf("%d completed · %d failed", j.CompletedToday, j.FailedToday)),
			}, "\n")
		}),
		m.alertsBlock(3),
	}
	return strings.Join(blocks, "\n\n")
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
	return strings.Join([]string{
		section("Needs attention", d.Torrents, func(t api.Torrents) string {
			if len(t.Attention) == 0 {
				return styleOK.Render("Nothing errored or stalled.")
			}
			return m.torrentTable(t.Attention)
		}),
		section("Active", d.Torrents, func(t api.Torrents) string {
			if len(t.Active) == 0 {
				return styleMuted.Render("Nothing transferring.")
			}
			out := m.torrentTable(t.Active)
			if t.Truncated {
				// Never a silent cut: a list that quietly stops at 25 reads as
				// "that is all of them".
				out += "\n" + styleMuted.Render("… capped by the server; this is not the full list.")
			}
			return out
		}),
		section("Queue", d.Queue, func(q api.Queue) string {
			if len(q.Entries) == 0 {
				return styleMuted.Render("The scheduler has no pending decisions.")
			}
			lines := make([]string, 0, len(q.Entries))
			for _, e := range q.Entries {
				reason := ""
				if e.Reason != nil {
					reason = styleMuted.Render(" — " + *e.Reason)
				}
				lines = append(lines, pad(e.Decision, 10)+pad(truncate(e.Name, 48), 50)+reason)
			}
			return strings.Join(lines, "\n")
		}),
	}, "\n\n")
}

func (m Model) torrentTable(list []api.Torrent) string {
	nameW := m.width - 58
	if nameW < 20 {
		nameW = 20
	}
	head := styleColHead.Render(
		pad("NAME", nameW) + " " + pad("STATE", 12) + " " + padLeft("PROG", 10) + " " +
			padLeft("↓", 10) + " " + padLeft("↑", 10) + " " + padLeft("ETA", 7),
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
			padLeft(fmt.Sprintf("%s %3.0f%%", progressBar(t.Progress, 4), t.Progress*100), 10),
			styleAccent.Render(padLeft(humanRate(t.DownloadRate), 10)),
			styleOK.Render(padLeft(humanRate(t.UploadRate), 10)),
			styleMuted.Render(padLeft(humanETA(t.ETA), 7)),
		}, " "))
	}
	return strings.Join(lines, "\n")
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

func (m Model) viewMedia() string {
	d := m.snapshot.Domains
	return strings.Join([]string{
		section("Library", d.Media, func(md api.Media) string {
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
		}),
		section("Intake", d.MediaIntake, func(mi api.MediaIntake) string {
			lines := []string{
				kv("Active", fmt.Sprintf("%d", mi.Active)),
				kv("Failed", errIf(mi.Failed)),
				kv("Quarantined", warnIf(mi.Quarantined)),
				kv("Imported today", fmt.Sprintf("%d", mi.ImportedToday)),
			}
			if len(mi.Recent) > 0 {
				lines = append(lines, "", styleColHead.Render(pad("RECENT", 44)+pad("STATE", 14)+"WHEN"))
				for _, j := range mi.Recent {
					line := pad(truncate(j.Title, 42), 44) + pad(j.State, 14) + styleMuted.Render(ago(&j.At))
					if j.Error != nil {
						line += "\n" + styleErr.Render("    "+truncate(*j.Error, m.width-8))
					}
					lines = append(lines, line)
				}
			}
			return strings.Join(lines, "\n")
		}),
		section("Playing now", d.Playback, func(p api.Playback) string {
			if len(p.Sessions) == 0 {
				return styleMuted.Render("Nobody is watching anything.")
			}
			lines := make([]string, 0, len(p.Sessions))
			for _, s := range p.Sessions {
				mode := "direct"
				if s.Transcode {
					mode = styleWarn.Render("transcode")
				}
				lines = append(lines, fmt.Sprintf("%s %s %s %s",
					pad(truncate(s.Title, 40), 42),
					pad(s.User, 16),
					pad(mode, 12),
					progressBar(s.Progress, 10),
				))
			}
			return strings.Join(lines, "\n")
		}),
	}, "\n\n")
}

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

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

func (m Model) viewJobs() string {
	d := m.snapshot.Domains
	return strings.Join([]string{
		section("Jobs", d.Jobs, func(j api.Jobs) string {
			rate := "—"
			if j.SuccessRate != nil {
				rate = fmt.Sprintf("%.0f%%", *j.SuccessRate)
			}
			lines := []string{
				kv("Running", fmt.Sprintf("%d", j.Running)),
				kv("Queued", fmt.Sprintf("%d", j.Queued)),
				kv("Failed", errIf(j.Failed)),
				kv("Success today", rate),
			}
			if len(j.Recent) > 0 {
				lines = append(lines, "", styleColHead.Render(pad("TYPE", 34)+pad("STATUS", 14)+pad("PROG", 6)+"WHEN"))
				for _, job := range j.Recent {
					prog := "—"
					if job.Progress != nil {
						prog = fmt.Sprintf("%d%%", *job.Progress)
					}
					style := styleBase
					if job.Status == "failed" {
						style = styleErr
					}
					line := pad(truncate(job.Type, 32), 34) + style.Render(pad(job.Status, 14)) +
						pad(prog, 6) + styleMuted.Render(ago(&job.At))
					if job.Error != nil {
						line += styleErr.Render("  " + *job.Error)
					}
					lines = append(lines, line)
				}
			}
			return strings.Join(lines, "\n")
		}),
		section("Automation", d.Automation, func(a api.Automation) string {
			lines := []string{
				kv("Rules", fmt.Sprintf("%d", len(a.Rules))),
				kv("Failures (24h)", errIf(a.Failures24h)),
			}
			for _, r := range a.RecentRuns {
				style := styleBase
				if r.Result != "success" {
					style = styleWarn
				}
				lines = append(lines, pad(truncate(r.RuleName, 30), 32)+style.Render(pad(r.Result, 12))+styleMuted.Render(ago(&r.At)))
			}
			return strings.Join(lines, "\n")
		}),
	}, "\n\n")
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

func (m Model) viewAcquisition() string {
	return section("Acquisition", m.snapshot.Domains.Acquisition, func(a api.Acquisition) string {
		lines := []string{kv("Grabs (24h)", fmt.Sprintf("%d", a.Grabs24h)), ""}
		lines = append(lines, styleColHead.Render(pad("FEED", 30)+pad("RULES", 7)+pad("POLLED", 14)+"STATE"))
		for _, f := range a.Feeds {
			state := styleOK.Render("ok")
			if !f.Enabled {
				state = styleMuted.Render("disabled")
			} else if overdue(f.LastPolledAt, f.RefreshIntervalSeconds) {
				// Staleness against the feed's own interval is the only health
				// signal available: RSS poll failures are logged, never stored.
				state = styleWarn.Render("overdue")
			}
			lines = append(lines, pad(truncate(f.Name, 28), 30)+
				pad(fmt.Sprintf("%d", f.RuleCount), 7)+
				pad(ago(f.LastPolledAt), 14)+state)
		}
		if len(a.Recent) > 0 {
			lines = append(lines, "", styleColHead.Render(pad("RELEASE", 46)+pad("RESULT", 18)+"WHEN"))
			for _, e := range a.Recent {
				style := styleMuted
				switch e.Result {
				case "downloaded":
					style = styleOK
				case "matched":
					// "A rule wanted this and it was not taken" — the state
					// worth an operator's attention, which is why the contract
					// keeps it distinct from a plain rejection.
					style = styleWarn
				}
				lines = append(lines, pad(truncate(e.ReleaseTitle, 44), 46)+
					style.Render(pad(e.Result, 18))+styleMuted.Render(ago(&e.At)))
			}
		}
		return strings.Join(lines, "\n")
	})
}

func overdue(last *string, intervalSeconds int) bool {
	if last == nil || *last == "" || intervalSeconds <= 0 {
		return false
	}
	t, err := time.Parse(time.RFC3339, *last)
	if err != nil {
		return false
	}
	// Twice the interval, not once: a poll that lands a moment late is normal
	// and flagging it would make "overdue" meaningless.
	return time.Since(t) > 2*time.Duration(intervalSeconds)*time.Second
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

func (m Model) viewInfra() string {
	d := m.snapshot.Domains
	return strings.Join([]string{
		section("Engines", d.Engines, func(list []api.Engine) string {
			if len(list) == 0 {
				return styleMuted.Render("No engines configured.")
			}
			lines := make([]string, 0, len(list))
			for _, e := range list {
				count := "—"
				if e.TorrentCount != nil {
					count = fmt.Sprintf("%d", *e.TorrentCount)
				}
				line := healthStyle(e.Health).Render(healthMark(e.Health)) + " " +
					pad(e.EngineID, 26) + pad(e.Kind, 14) +
					padLeft(count, 7) + "  " + styleMuted.Render("seen "+ago(e.LastSeenAt))
				if e.Error != nil {
					line += "\n    " + styleErr.Render(truncate(*e.Error, m.width-6))
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n")
		}),
		section("Indexers", d.Indexers, func(list []api.Indexer) string {
			if len(list) == 0 {
				return styleMuted.Render("No indexers configured.")
			}
			lines := make([]string, 0, len(list))
			for _, i := range list {
				line := healthStyle(i.Health).Render(healthMark(i.Health)) + " " +
					pad(truncate(i.Name, 28), 30) + pad(i.Protocol, 10) +
					styleMuted.Render("tested "+ago(i.LastTestedAt))
				if i.Message != nil && i.Health != api.HealthHealthy {
					line += "\n    " + styleWarn.Render(truncate(*i.Message, m.width-6))
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n")
		}),
		section("Providers", d.Providers, func(list []api.Provider) string {
			if len(list) == 0 {
				return styleMuted.Render("No providers configured.")
			}
			lines := make([]string, 0, len(list))
			for _, p := range list {
				line := healthStyle(p.Health).Render(healthMark(p.Health)) + " " +
					pad(truncate(p.Name, 26), 28) + pad(p.Category, 16) +
					styleMuted.Render("checked "+ago(p.LastCheckedAt))
				if p.Message != nil && p.Health != api.HealthHealthy {
					line += "\n    " + styleWarn.Render(truncate(*p.Message, m.width-6))
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n")
		}),
	}, "\n\n")
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

func (m Model) viewActivity() string {
	d := m.snapshot.Domains
	return strings.Join([]string{
		section("Recent activity", d.RecentActivity, func(list []api.ActivityItem) string {
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
				line := styleMuted.Render(pad(ago(&a.At), 12)) + levelStyle(a.Level).Render(truncate(a.Message, m.width-16)) + count
				if a.Detail != nil && *a.Detail != "" {
					line += "\n" + styleMuted.Render("            "+truncate(*a.Detail, m.width-14))
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n")
		}),
		section("Notifications", d.Notifications, func(n api.Notifications) string {
			return strings.Join([]string{
				kv("Pending", fmt.Sprintf("%d", n.Pending)),
				kv("Failed (24h)", errIf(n.Failed24h)),
			}, "\n")
		}),
	}, "\n\n")
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

func (m Model) viewAlerts() string { return m.alertsBlock(0) }

// alertsBlock renders the attention list; limit 0 means all of them.
func (m Model) alertsBlock(limit int) string {
	return section("Attention", m.snapshot.Domains.Alerts, func(list []api.Alert) string {
		if len(list) == 0 {
			return styleOK.Render("Nothing needs attention.")
		}
		shown := list
		if limit > 0 && len(shown) > limit {
			shown = shown[:limit]
		}
		lines := make([]string, 0, len(shown)+1)
		for _, a := range shown {
			style := severityStyle(a.Severity)
			line := style.Render(severityMark(a.Severity)+" "+a.Title) + styleMuted.Render("  ["+a.Domain+"]")
			if a.Detail != nil && *a.Detail != "" {
				line += "\n  " + styleMuted.Render(truncate(*a.Detail, m.width-4))
			}
			if a.Since != nil {
				line += styleMuted.Render("  since " + ago(a.Since))
			}
			lines = append(lines, line)
		}
		if limit > 0 && len(list) > limit {
			lines = append(lines, styleMuted.Render(fmt.Sprintf("… and %d more (press 8)", len(list)-limit)))
		}
		/*
		 * Said once, here: these are computed from current state each time the
		 * snapshot is built. They cannot be acknowledged or silenced, and the
		 * way to make one go away is to fix what it reports. A console offering
		 * a dismiss key would be promising something the server cannot honour.
		 */
		return strings.Join(lines, "\n")
	})
}
