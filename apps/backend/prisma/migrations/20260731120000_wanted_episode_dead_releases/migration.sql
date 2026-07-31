-- Let an episode remember which releases turned out to be dead.
--
-- The sweep selects only `idle`, `no_results` and `failed`. A row that reaches
-- `grabbed` is never looked at again — so when its torrent is parked with zero
-- seeders and never completes, the episode is neither owned nor searchable, and
-- the UI reports "grabbed", which reads as success. Measured on a live install:
-- 369 episodes stamped grabbed but still missing, 357 of them over a week old,
-- against 599 parked torrents (292 no_seeders, 307 stalled).
--
-- Resetting those rows alone would only churn: the selector ranks the same
-- candidate list and re-picks the same dead release. Recording what has already
-- been proven dead is what makes a retry converge on a different release.
--
-- Additive with a default, so existing rows read `{}` — no episode is treated as
-- having failed anything it has not actually tried.

ALTER TABLE "wanted_episodes" ADD COLUMN "deadReleases" TEXT[] NOT NULL DEFAULT '{}';
