-- New/upcoming eligibility for discovery templates.
--
-- Auto-monitoring was never actually testing whether a series was NEW. The only
-- date check asked whether the title had any release date of a wanted type in
-- the forward window, and TVmaze reports `episode_air` and `season_premiere` for
-- shows that started years ago — so a 2022 series airing this week qualified,
-- and the category policy then monitored it.
--
-- Every default here is the safe one. `requireUpcoming` is ON, the grace period
-- is zero, past releases go to review rather than being acted on, and a
-- returning series is only continued when it is already here.

ALTER TABLE "discovery_templates"
  ADD COLUMN "requireUpcoming"         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "gracePeriodDays"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pastReleaseBehavior"     TEXT    NOT NULL DEFAULT 'review',
  ADD COLUMN "returningSeriesBehavior" TEXT    NOT NULL DEFAULT 'existing_only';

-- Existing templates re-decide their catalogue under the new rule rather than
-- keeping verdicts reached without it. Without this bump every title already
-- judged would keep the decision the old, dateless policy gave it — including
-- the old series it should never have monitored.
UPDATE "discovery_templates" SET "policyVersion" = "policyVersion" + 1;
DELETE FROM "discovery_evaluations";
