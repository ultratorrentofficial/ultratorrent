-- The exact instant a release airs, when the provider states one.
--
-- TVmaze publishes `airstamp` (e.g. 2026-09-06T04:00:00+00:00) alongside
-- `airdate`, and only the former can be converted to a viewer's timezone.
-- `airdate` is the network's LOCAL calendar date: rendering it as an instant
-- moves it a day for anyone west of UTC, so the two are stored separately and
-- the UI picks based on which is present.
ALTER TABLE "discovered_media_release_dates"
  ADD COLUMN "airsAt" TIMESTAMP(3);
