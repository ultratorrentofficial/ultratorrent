-- Duplicate Center domain model (Phase 1).
--
-- Additive and backward-compatible: every existing column is untouched, every new
-- column is defaulted or nullable, and `MediaItem.duplicateGroupId` stays exactly as
-- it was so the current list endpoint keeps working unchanged.
--
-- The load-bearing addition is `groupKey`. Detection deleted every group and
-- recreated it on each run, so a group's id changed every scan and a human decision
-- had nothing durable to attach to — "this is not a duplicate" could not survive
-- until the next scan. Existing rows are backfilled with a legacy key derived from
-- their id, which is unique by construction; the first detection run after this
-- migration replaces them with real signal-derived keys.

ALTER TABLE "media_duplicate_groups"
  ADD COLUMN "groupKey" TEXT,
  ADD COLUMN "groupType" TEXT NOT NULL DEFAULT 'file',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN "confidence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requiresReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "potentialSavingsBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "recommendedItemId" TEXT,
  ADD COLUMN "recommendation" JSONB,
  ADD COLUMN "warnings" JSONB,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "ignoredReason" TEXT,
  ADD COLUMN "ignoredById" TEXT,
  ADD COLUMN "ignoredAt" TIMESTAMP(3),
  ADD COLUMN "resolvedById" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "media_duplicate_groups" SET "groupKey" = 'legacy:' || "id" WHERE "groupKey" IS NULL;
ALTER TABLE "media_duplicate_groups" ALTER COLUMN "groupKey" SET NOT NULL;

CREATE UNIQUE INDEX "media_duplicate_groups_groupKey_key" ON "media_duplicate_groups"("groupKey");
CREATE INDEX "media_duplicate_groups_status_idx" ON "media_duplicate_groups"("status");
CREATE INDEX "media_duplicate_groups_groupType_idx" ON "media_duplicate_groups"("groupType");
CREATE INDEX "media_duplicate_groups_requiresReview_idx" ON "media_duplicate_groups"("requiresReview");
CREATE INDEX "media_duplicate_groups_confidence_idx" ON "media_duplicate_groups"("confidence");
CREATE INDEX "media_duplicate_groups_reason_idx" ON "media_duplicate_groups"("reason");
CREATE INDEX "media_duplicate_groups_resolvedAt_idx" ON "media_duplicate_groups"("resolvedAt");
CREATE INDEX "media_duplicate_groups_ignoredAt_idx" ON "media_duplicate_groups"("ignoredAt");
CREATE INDEX "media_duplicate_groups_potentialSavingsBytes_idx" ON "media_duplicate_groups"("potentialSavingsBytes");

CREATE TABLE "media_duplicate_candidates" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "fileSize" BIGINT NOT NULL DEFAULT 0,
  "hash" TEXT,
  "qualityScore" INTEGER NOT NULL DEFAULT 0,
  "recommendationRank" INTEGER NOT NULL DEFAULT 0,
  "recommendationReasons" JSONB,
  "selectedAction" TEXT NOT NULL DEFAULT 'none',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_duplicate_candidates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_duplicate_candidates_groupId_itemId_key" ON "media_duplicate_candidates"("groupId", "itemId");
CREATE INDEX "media_duplicate_candidates_groupId_idx" ON "media_duplicate_candidates"("groupId");
CREATE INDEX "media_duplicate_candidates_itemId_idx" ON "media_duplicate_candidates"("itemId");

CREATE TABLE "media_duplicate_resolutions" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "keepItemId" TEXT,
  "preview" JSONB,
  "groupVersion" INTEGER NOT NULL DEFAULT 0,
  "expectedSavingsBytes" BIGINT NOT NULL DEFAULT 0,
  "actualSavingsBytes" BIGINT NOT NULL DEFAULT 0,
  "errorSummary" TEXT,
  "createdById" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_duplicate_resolutions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_duplicate_resolutions_groupId_idx" ON "media_duplicate_resolutions"("groupId");
CREATE INDEX "media_duplicate_resolutions_status_idx" ON "media_duplicate_resolutions"("status");
CREATE INDEX "media_duplicate_resolutions_createdAt_idx" ON "media_duplicate_resolutions"("createdAt");

CREATE TABLE "media_duplicate_resolution_actions" (
  "id" TEXT NOT NULL,
  "resolutionId" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "sourcePath" TEXT,
  "destinationPath" TEXT,
  "errorMessage" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_duplicate_resolution_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_duplicate_resolution_actions_resolutionId_idx" ON "media_duplicate_resolution_actions"("resolutionId");
CREATE INDEX "media_duplicate_resolution_actions_status_idx" ON "media_duplicate_resolution_actions"("status");

ALTER TABLE "media_duplicate_candidates" ADD CONSTRAINT "media_duplicate_candidates_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "media_duplicate_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_duplicate_candidates" ADD CONSTRAINT "media_duplicate_candidates_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_duplicate_resolutions" ADD CONSTRAINT "media_duplicate_resolutions_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "media_duplicate_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_duplicate_resolution_actions" ADD CONSTRAINT "media_duplicate_resolution_actions_resolutionId_fkey"
  FOREIGN KEY ("resolutionId") REFERENCES "media_duplicate_resolutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
