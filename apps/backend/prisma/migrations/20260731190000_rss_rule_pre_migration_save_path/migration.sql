-- Remember where a rule downloaded before the migration wizard moved it.
--
-- Converting a rule to managed intake is two coordinated changes: repoint
-- `savePath` at staging, and set `importMode`. Reverting must undo BOTH. A rule
-- left on `legacy_direct` with a staging save path downloads into staging, where
-- nothing imports from — so a revert that only flipped the mode back would
-- silently strand every future episode of that show.
--
-- Nullable and additive: null means the wizard never touched this rule, which is
-- true of every row that exists today.

ALTER TABLE "rss_rules" ADD COLUMN "preMigrationSavePath" TEXT;
