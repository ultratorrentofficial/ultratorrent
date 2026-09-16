-- Media Intelligence (Phase 6): remediation plans.
--
-- Additive. THREE new tables and their indexes. No existing column is altered,
-- no existing row is rewritten, and nothing is backfilled. The two foreign keys
-- into existing Media Intelligence tables are added as constraints only.
--
-- These tables are OPERATIONAL TRUTH, not derived state. Every other table in
-- this module except `media_lifecycle_policies` holds a conclusion the module
-- drew and can rebuild from the source domains. A plan records what
-- UltraTorrent actually intended and did, so:
--
--   * a rebuild must never truncate it;
--   * it outlives the finding and recommendation that justified it (both FKs
--     are ON DELETE SET NULL, never CASCADE) -- "why did this happen" has to
--     stay answerable after the condition it responded to is gone;
--   * only the state machine may write `status`.
--
-- No seed rows. An installation starts with no plans, and "no plan" is a
-- first-class state meaning nothing has been proposed -- never a fabricated one.
--
-- Applied with `prisma migrate deploy`. NEVER via a shadow-db diff against a
-- live DATABASE_URL -- `migrate diff --from-migrations` RESETS its target.
--
-- On CREATE INDEX: these tables start EMPTY, so the indexes build instantly.
-- The standing prohibition concerns large populated tables, where a blocking
-- build that gets killed leaves P3009 and a restart-looping backend.

CREATE TABLE IF NOT EXISTS "media_remediation_plans" (
  "id"         TEXT NOT NULL,

  -- movie | series | season | episode -- the projection's own identity.
  "entityType" TEXT NOT NULL,
  "entityId"   TEXT NOT NULL,

  -- All nullable: a plan survives its inputs so the history stays readable.
  "findingId"        TEXT,
  "recommendationId" TEXT,
  "policyId"         TEXT,

  "type"      TEXT NOT NULL,
  -- See REMEDIATION_PLAN_STATUSES. Text, not a PG enum: adding a state must be
  -- a code change, not a migration that locks the table.
  "status"    TEXT NOT NULL DEFAULT 'proposed',
  -- low | moderate | destructive | irreversible. Independent of policy mode;
  -- the safety evaluator combines them and the stricter one wins.
  "riskClass" TEXT NOT NULL DEFAULT 'low',

  "blockReason" TEXT,
  -- Bounded and scalar. Never a provider payload, never a credentialed URL.
  "explanation" JSONB NOT NULL DEFAULT '{}',

  -- What the plan was justified BY, hashed. Compared immediately before
  -- execution; any difference supersedes rather than proceeds.
  "desiredStateFingerprint"   TEXT,
  "recommendationFingerprint" TEXT,
  "verificationFingerprint"   TEXT,

  -- Approval pins the exact plan a person saw.
  "approvedById"        TEXT,
  "approvedAt"          TIMESTAMP(3),
  "approvedFingerprint" TEXT,
  -- A plan not executed before this is refused; fingerprints decay.
  "expiresAt"           TIMESTAMP(3),

  "createdById"      TEXT,
  "startedAt"        TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "supersededAt"     TIMESTAMP(3),
  "supersededReason" TEXT,

  "failureClass"   TEXT,
  "failureMessage" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_remediation_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "media_remediation_steps" (
  "id"     TEXT NOT NULL,
  "planId" TEXT NOT NULL,

  "ordinal" INTEGER NOT NULL,
  "kind"    TEXT NOT NULL,
  -- Which module owns the mutation. The executor orchestrates; it never owns.
  "ownerDomain"        TEXT NOT NULL,
  "capabilityId"       TEXT,
  -- The permission the OWNING domain requires, recorded so an authority change
  -- between approval and execution is detectable.
  "requiredPermission" TEXT,

  "status" TEXT NOT NULL DEFAULT 'pending',

  -- Bounded scalar inputs, resolved server-side. Never secrets, never a path
  -- supplied by a client.
  "inputSnapshot"         JSONB NOT NULL DEFAULT '{}',
  "expectedPostcondition" JSONB NOT NULL DEFAULT '{}',

  -- Deterministic, so a duplicate delivery cannot double-execute.
  "idempotencyKey" TEXT,

  "attemptCount"   INTEGER NOT NULL DEFAULT 0,
  "failureClass"   TEXT,
  "failureMessage" TEXT,
  -- Distinct from a failure: a precondition said this step was unnecessary.
  "skipReason"     TEXT,

  "startedAt"   TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_remediation_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "media_remediation_plan_events" (
  "id"     TEXT NOT NULL,
  "planId" TEXT NOT NULL,

  "event" TEXT NOT NULL,
  -- Null for machine transitions: no person did it. Mirrors
  -- `media_intelligence_finding_events`, which the UI already renders as
  -- "by system" when the actor is absent.
  "actorUserId" TEXT,
  "detail"      JSONB NOT NULL DEFAULT '{}',

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_remediation_plan_events_pkey" PRIMARY KEY ("id")
);

-- --- plans -----------------------------------------------------------------

-- The scheduler's claim query: eligible plans, oldest first.
CREATE INDEX IF NOT EXISTS "media_remediation_plans_status_createdAt_idx"
  ON "media_remediation_plans" ("status", "createdAt");

-- "Is there already a plan for this entity?" -- the dedupe lookup.
CREATE INDEX IF NOT EXISTS "media_remediation_plans_entityType_entityId_status_idx"
  ON "media_remediation_plans" ("entityType", "entityId", "status");

CREATE INDEX IF NOT EXISTS "media_remediation_plans_recommendationId_idx"
  ON "media_remediation_plans" ("recommendationId");

CREATE INDEX IF NOT EXISTS "media_remediation_plans_policyId_idx"
  ON "media_remediation_plans" ("policyId");

-- The expiry sweep.
CREATE INDEX IF NOT EXISTS "media_remediation_plans_status_expiresAt_idx"
  ON "media_remediation_plans" ("status", "expiresAt");

/*
 * ONE ACTIVE PLAN PER RECOMMENDATION.
 *
 * The same drift must not spawn unlimited plans. This cannot be a plain
 * UNIQUE constraint and Prisma cannot express it, because terminal plans are
 * history: a succeeded plan from last week must not block a new one today.
 * A PARTIAL unique index says exactly what is meant -- at most one plan per
 * recommendation among the statuses that are still going somewhere.
 *
 * The status list is duplicated from TERMINAL_PLAN_STATUSES in
 * `packages/shared/src/media-remediation.ts` because SQL cannot import it.
 * A test asserts the two agree; if you add a terminal status, change both.
 */
CREATE UNIQUE INDEX IF NOT EXISTS "media_remediation_plans_active_recommendation_key"
  ON "media_remediation_plans" ("recommendationId")
  WHERE "recommendationId" IS NOT NULL
    AND "status" NOT IN ('succeeded', 'failed', 'cancelled', 'superseded');

-- --- steps -----------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "media_remediation_steps_planId_ordinal_key"
  ON "media_remediation_steps" ("planId", "ordinal");

CREATE INDEX IF NOT EXISTS "media_remediation_steps_planId_status_idx"
  ON "media_remediation_steps" ("planId", "status");

CREATE INDEX IF NOT EXISTS "media_remediation_steps_status_idx"
  ON "media_remediation_steps" ("status");

-- Correlating a wake-up (a finished download, a completed import) back to the
-- step that is waiting for it.
CREATE INDEX IF NOT EXISTS "media_remediation_steps_idempotencyKey_idx"
  ON "media_remediation_steps" ("idempotencyKey");

-- --- history ---------------------------------------------------------------

-- The detail timeline reads one plan's history, newest first.
CREATE INDEX IF NOT EXISTS "media_remediation_plan_events_planId_createdAt_idx"
  ON "media_remediation_plan_events" ("planId", "createdAt");

-- --- foreign keys ----------------------------------------------------------

-- SET NULL, never CASCADE: a plan records what UltraTorrent did and must
-- outlive the finding and the recommendation that justified it.
ALTER TABLE "media_remediation_plans"
  ADD CONSTRAINT "media_remediation_plans_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "media_intelligence_findings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_remediation_plans"
  ADD CONSTRAINT "media_remediation_plans_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "media_intelligence_recommendations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Steps and history have no meaning without their plan, so these DO cascade.
ALTER TABLE "media_remediation_steps"
  ADD CONSTRAINT "media_remediation_steps_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "media_remediation_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_remediation_plan_events"
  ADD CONSTRAINT "media_remediation_plan_events_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "media_remediation_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
