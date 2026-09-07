-- Database-level protection for the discovery identity gate.
--
-- The resolver decides whether a work already exists, but a resolver is a
-- check-then-insert and two concurrent passes can both pass the check. TMDB and
-- TVmaze syncing the same title, or a manual evaluate racing the hourly tick,
-- could each create a rule for the same discovered title.
--
-- PARTIAL, deliberately. PostgreSQL treats NULLs as distinct in a unique index,
-- so a plain unique over a nullable column constrains nothing at all — every
-- hand-made rule has a NULL `discoveredMediaId` and they must remain unlimited.
-- The predicate restricts the constraint to rows that actually carry an identity.

-- At most one generated rule per discovered title.
CREATE UNIQUE INDEX IF NOT EXISTS "rss_rules_discovered_media_generated_key"
  ON "rss_rules" ("discoveredMediaId")
  WHERE "discoveredMediaId" IS NOT NULL AND "generatedByDiscovery" = true;

-- Deliberately NOT added: uniqueness over (title, year).
--
-- Two different works genuinely share a title and a year — TMDB carries three
-- separate 2026 films called "The Odyssey". A constraint there would refuse a
-- legitimate second work, which is exactly what the `ambiguous` identity state
-- exists to surface for a person instead.
