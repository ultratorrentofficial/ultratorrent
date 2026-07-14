---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

feat(analytics): every chart on the Analytics Dashboard drills into the plays behind it

Click a Top Users bar, a Devices bar, a Quality bar, or a heatmap cell, and a drawer
opens onto the individual plays that slice was counted from — title, user, device,
quality, watch time, when — paginated, and scoped by the dashboard's own filter.

New `GET /media-server-analytics/reports/plays` (permission `view_history`, not
`view_reports`: an aggregate hides who watched what, and this does not).

The interesting part is that a chart's label **cannot be filtered on**, because it is
derived rather than stored:

- **Quality.** `1080p` is what the normalizer makes of the raw `1080p`, `1080`, and
  the junk `p` Tautulli emits. On a real library the `1080p` bar is 1,554 plays built
  from *two* raw values — filtering `resolution = '1080p'` would return 1,517 and
  silently lose 37. The endpoint resolves a label back to every raw value that folds
  into it, reading the raw set from the data itself, so a spelling the normalizer has
  never seen still drills into whichever bucket the chart actually put it in.
- **The `Unknown` bar is NULL**, not the string "Unknown" — filtering on the label
  would return an empty list for a bar reading hundreds of plays.
- **A folded `Other` bar** stands for the users/devices past the top N. Its name
  matches nothing in the data, so `foldTopN` now carries the values it folded and the
  drill-down filters on all of them.
- **The heatmap is bucketed in JS** (`getDay()`/`getHours()`). Re-implementing that as
  SQL `EXTRACT` would be a second implementation free to disagree with the grid on
  screen, so the drill-down buckets with the same calls — the row count cannot
  contradict the number printed in the cell.

Also fixes a latent bug this surfaced: `users()`/`devices()` mapped both NULL *and* a
viewer literally named "Unknown" to the label `Unknown` without merging them, so
`groupBy` could render two identically-named bars. They are now folded into one, and
its drill-down matches both.
