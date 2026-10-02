-- The newsletter's FORWARD window, for the upcoming-premiere section.
--
-- Every window this table already has looks BACKWARD: `dateRangeMode` is one of
-- since_last_send / last_days / since_date, all of which mean "what was added to
-- the library since X". An upcoming-TV section asks the opposite question — what
-- starts airing NEXT — about titles that have no library item at all, so it
-- carries its own window rather than overloading a field whose every mode means
-- "since".
--
-- `next_days` counts `airWindowDays` forward from the send moment.
-- `next_calendar_week` is Monday-Sunday of the following calendar week, resolved
-- in the newsletter's own `timezone` and never in the container's UTC — the same
-- trap `sendHour` already carries a scar for (a newsletter set to noon sent at
-- 08:00 local).
--
-- Both columns are NOT NULL with defaults, so existing newsletters need no
-- backfill: they keep a 7-day forward window that nothing reads until an
-- operator selects the upcoming section.
ALTER TABLE "media_server_newsletters"
  ADD COLUMN "airWindowMode" TEXT NOT NULL DEFAULT 'next_days',
  ADD COLUMN "airWindowDays" INTEGER NOT NULL DEFAULT 7;
