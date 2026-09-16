-- Media Intelligence (Phase 5): lifecycle policies.
--
-- Additive. ONE new table and its indexes. No existing column is altered, no
-- existing row is rewritten, and nothing is backfilled.
--
-- This is the first table in Media Intelligence that is NOT derived. Every
-- other table here (projections, findings, finding events, recommendations)
-- holds a conclusion the module drew and can rebuild from the source domains.
-- This one holds something a person authored, so:
--
--   * it is never truncated by a rebuild;
--   * deleting a policy removes intent only -- never media, never findings,
--     never history;
--   * no reconciliation path may write to it.
--
-- No seed rows. An installation starts with NO lifecycle policy at all, which
-- is the honest default: the system should not invent intent on the operator's
-- behalf, and "no policy" must be a first-class state that resolves to "no
-- desired state" rather than to a fabricated one.
--
-- Applied with `prisma migrate deploy`. NEVER via a shadow-db diff against a
-- live DATABASE_URL -- `migrate diff --from-migrations` RESETS its target.
--
-- On CREATE INDEX: this table starts EMPTY, so the indexes build instantly.
-- The standing prohibition concerns large populated tables, where a blocking
-- build that gets killed leaves P3009 and a restart-looping backend.

CREATE TABLE IF NOT EXISTS "media_lifecycle_policies" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  -- A disabled policy keeps its definition and stops contributing, so a
  -- disabled override falls through to its parent rather than pinning a value.
  "enabled"     BOOLEAN NOT NULL DEFAULT true,

  -- global | media_kind | library | series | movie
  "scopeType"   TEXT NOT NULL,
  -- NULL for `global`; otherwise a library id, media kind, show id or item id.
  "scopeId"     TEXT,

  -- recommend_only | approval_required. Deliberately no `automatic`: Phase 5
  -- ships no executor, and a mode implying one would be a lie.
  "mode"        TEXT NOT NULL DEFAULT 'recommend_only',

  -- Every dimension is NULLABLE, and NULL means "says nothing -- inherit from
  -- a broader scope". `do_not_manage` is a stored VALUE precisely because "I
  -- have no opinion" and "I want this explicitly unmanaged" are different
  -- instructions that a nullable column alone cannot both express.
  "quality"           TEXT,
  "completeness"      TEXT,
  -- NULL = not mentioned; [] = explicitly no required languages.
  "subtitleLanguages" JSONB,
  "acquisition"       JSONB,

  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_lifecycle_policies_pkey" PRIMARY KEY ("id")
);

-- The operator-facing identity: one policy of a given name per scope.
-- Note Postgres treats NULLs as distinct in a unique index, so this does not
-- constrain two global policies sharing a name; the service rejects that
-- explicitly rather than relying on the index to do it.
CREATE UNIQUE INDEX IF NOT EXISTS "media_lifecycle_policies_scopeType_scopeId_name_key"
  ON "media_lifecycle_policies" ("scopeType", "scopeId", "name");

-- The resolver loads every enabled policy once per evaluation pass and filters
-- scope in memory -- scope matching is not a pure SQL problem (a series policy
-- reaches an episode through its show). This keeps that read cheap.
CREATE INDEX IF NOT EXISTS "media_lifecycle_policies_enabled_scopeType_idx"
  ON "media_lifecycle_policies" ("enabled", "scopeType");
