-- Media Intelligence (Phase 3): persisted attention ordering rank.
--
-- Additive. One defaulted column and one index on the DERIVED findings table.
--
-- Why a column rather than an ORDER BY: `severity` is text, and sorting it
-- alphabetically yields critical < error < info < opportunity < warning --
-- close to the reverse of its meaning. The rank is therefore computed
-- (severityRank * 10 + acknowledged) and stored so Postgres can order and
-- page on an index rather than the service sorting a whole result set in
-- memory. It is derived like everything else here and can be recomputed from
-- the row at any time.
--
-- The backfill below is the one exception to this phase's "no data rewrite"
-- rule, and it is safe: it derives each row's rank from columns already on
-- that row, touches ~4k rows, and asserts nothing new about the media. The
-- DEFAULT of 20 (warning, unreviewed) only applies to rows inserted before
-- this statement runs.
--
-- Applied with `prisma migrate deploy`. NEVER a shadow-db diff against a live
-- DATABASE_URL.

ALTER TABLE "media_intelligence_findings"
  ADD COLUMN IF NOT EXISTS "attentionPriority" INTEGER NOT NULL DEFAULT 20;

UPDATE "media_intelligence_findings"
SET "attentionPriority" =
  (CASE "severity"
     WHEN 'critical'    THEN 0
     WHEN 'error'       THEN 1
     WHEN 'warning'     THEN 2
     WHEN 'opportunity' THEN 3
     WHEN 'info'        THEN 4
     ELSE 9
   END) * 10
  + (CASE WHEN "disposition" = 'acknowledged' THEN 1 ELSE 0 END);

-- Name matches Prisma's own output verbatim. Prisma truncates to Postgres'
-- 63-character identifier limit, and an index whose name differs from what
-- the schema implies is drift a later `migrate diff` will try to 'repair'.
CREATE INDEX IF NOT EXISTS "media_intelligence_findings_resolvedAt_attentionPriority_fi_idx"
  ON "media_intelligence_findings" ("resolvedAt", "attentionPriority", "firstObservedAt");
