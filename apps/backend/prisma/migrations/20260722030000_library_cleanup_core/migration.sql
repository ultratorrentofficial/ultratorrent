-- CreateTable
CREATE TABLE "media_cleanup_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'report_only',
    "scheduleCron" TEXT,
    "freeSpaceTriggerPercent" INTEGER,
    "currentDraftVersionId" TEXT,
    "publishedVersionId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "media_cleanup_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_policy_versions" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "document" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "requiredPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "factKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changeNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "media_cleanup_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_runs" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "simulate" BOOLEAN NOT NULL DEFAULT false,
    "jobId" TEXT,
    "inputDigest" TEXT,
    "filesScanned" INTEGER NOT NULL DEFAULT 0,
    "itemsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "candidatesMatched" INTEGER NOT NULL DEFAULT 0,
    "candidatesExcluded" INTEGER NOT NULL DEFAULT 0,
    "candidatesEligible" INTEGER NOT NULL DEFAULT 0,
    "estimatedReclaimBytes" BIGINT NOT NULL DEFAULT 0,
    "actualReclaimBytes" BIGINT NOT NULL DEFAULT 0,
    "exclusionBreakdown" JSONB,
    "errorSummary" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_cleanup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_candidates" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "mediaItemId" TEXT,
    "mediaFileId" TEXT,
    "mediaLibraryId" TEXT,
    "path" TEXT NOT NULL,
    "fileSizeBytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "exclusionReason" TEXT,
    "fingerprint" TEXT NOT NULL,
    "reasonSnapshot" JSONB NOT NULL,
    "rankScore" DOUBLE PRECISION,
    "rankReasons" JSONB,
    "replacementFileId" TEXT,
    "replacementReasons" JSONB,
    "protectionState" JSONB,
    "estimatedReclaimBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_cleanup_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_plans" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "action" TEXT NOT NULL DEFAULT 'trash',
    "retentionDays" INTEGER,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedReclaimBytes" BIGINT NOT NULL DEFAULT 0,
    "actualReclaimBytes" BIGINT NOT NULL DEFAULT 0,
    "executionJobId" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_cleanup_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_actions" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "mediaItemId" TEXT,
    "mediaFileId" TEXT,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourcePath" TEXT NOT NULL,
    "destinationPath" TEXT,
    "pinnedFingerprint" TEXT NOT NULL,
    "fileSizeBytes" BIGINT NOT NULL DEFAULT 0,
    "reclaimedBytes" BIGINT NOT NULL DEFAULT 0,
    "skipReason" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_cleanup_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_protections" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "mediaItemId" TEXT,
    "mediaFileId" TEXT,
    "mediaShowId" TEXT,
    "mediaLibraryId" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "externalIdentityKey" TEXT,
    "pathPrefix" TEXT,
    "tagValue" TEXT,
    "collectionId" TEXT,
    "torrentHash" TEXT,
    "canonicalPathSnapshot" TEXT,
    "protectionType" TEXT NOT NULL,
    "conditionKind" TEXT,
    "conditionConfig" JSONB,
    "reason" TEXT NOT NULL,
    "protectedUntil" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "media_cleanup_protections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_cleanup_quarantine_items" (
    "id" TEXT NOT NULL,
    "actionId" TEXT,
    "planId" TEXT,
    "runId" TEXT,
    "policyVersionId" TEXT,
    "mediaItemId" TEXT,
    "mediaFileId" TEXT,
    "originalPath" TEXT NOT NULL,
    "quarantinePath" TEXT NOT NULL,
    "storageRoot" TEXT NOT NULL,
    "fileSizeBytes" BIGINT NOT NULL DEFAULT 0,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quarantined',
    "restoreDeadline" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "restoredById" TEXT,
    "purgedAt" TIMESTAMP(3),
    "purgedById" TEXT,

    CONSTRAINT "media_cleanup_quarantine_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_playback_aggregates" (
    "id" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "startedPlayCount" INTEGER NOT NULL DEFAULT 0,
    "completedPlayCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewerCount" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedAt" TIMESTAMP(3),
    "maximumProgressPercent" INTEGER NOT NULL DEFAULT 0,
    "averageProgressPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPlaybackSeconds" BIGINT NOT NULL DEFAULT 0,
    "completionThresholdPercent" INTEGER NOT NULL DEFAULT 90,
    "sourceRowCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedSourceRowCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_playback_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_cleanup_policies_status_idx" ON "media_cleanup_policies"("status");

-- CreateIndex
CREATE INDEX "media_cleanup_policies_enabled_idx" ON "media_cleanup_policies"("enabled");

-- CreateIndex
CREATE INDEX "media_cleanup_policies_enabled_scheduleCron_idx" ON "media_cleanup_policies"("enabled", "scheduleCron");

-- CreateIndex
CREATE INDEX "media_cleanup_policies_enabled_freeSpaceTriggerPercent_idx" ON "media_cleanup_policies"("enabled", "freeSpaceTriggerPercent");

-- CreateIndex
CREATE INDEX "media_cleanup_policies_updatedAt_idx" ON "media_cleanup_policies"("updatedAt");

-- CreateIndex
CREATE INDEX "media_cleanup_policy_versions_policyId_idx" ON "media_cleanup_policy_versions"("policyId");

-- CreateIndex
CREATE INDEX "media_cleanup_policy_versions_status_idx" ON "media_cleanup_policy_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "media_cleanup_policy_versions_policyId_versionNumber_key" ON "media_cleanup_policy_versions"("policyId", "versionNumber");

-- CreateIndex
CREATE INDEX "media_cleanup_runs_policyId_createdAt_idx" ON "media_cleanup_runs"("policyId", "createdAt");

-- CreateIndex
CREATE INDEX "media_cleanup_runs_status_createdAt_idx" ON "media_cleanup_runs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "media_cleanup_runs_jobId_idx" ON "media_cleanup_runs"("jobId");

-- CreateIndex
CREATE INDEX "media_cleanup_runs_createdAt_idx" ON "media_cleanup_runs"("createdAt");

-- CreateIndex
CREATE INDEX "media_cleanup_candidates_runId_status_idx" ON "media_cleanup_candidates"("runId", "status");

-- CreateIndex
CREATE INDEX "media_cleanup_candidates_runId_rankScore_idx" ON "media_cleanup_candidates"("runId", "rankScore");

-- CreateIndex
CREATE INDEX "media_cleanup_candidates_mediaFileId_idx" ON "media_cleanup_candidates"("mediaFileId");

-- CreateIndex
CREATE INDEX "media_cleanup_candidates_mediaItemId_idx" ON "media_cleanup_candidates"("mediaItemId");

-- CreateIndex
CREATE INDEX "media_cleanup_candidates_status_idx" ON "media_cleanup_candidates"("status");

-- CreateIndex
CREATE INDEX "media_cleanup_plans_runId_idx" ON "media_cleanup_plans"("runId");

-- CreateIndex
CREATE INDEX "media_cleanup_plans_status_expiresAt_idx" ON "media_cleanup_plans"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "media_cleanup_plans_status_createdAt_idx" ON "media_cleanup_plans"("status", "createdAt");

-- CreateIndex
CREATE INDEX "media_cleanup_actions_planId_status_idx" ON "media_cleanup_actions"("planId", "status");

-- CreateIndex
CREATE INDEX "media_cleanup_actions_candidateId_idx" ON "media_cleanup_actions"("candidateId");

-- CreateIndex
CREATE INDEX "media_cleanup_actions_status_idx" ON "media_cleanup_actions"("status");

-- CreateIndex
CREATE INDEX "media_cleanup_actions_mediaFileId_idx" ON "media_cleanup_actions"("mediaFileId");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_mediaItemId_idx" ON "media_cleanup_protections"("mediaItemId");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_mediaFileId_idx" ON "media_cleanup_protections"("mediaFileId");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_mediaShowId_idx" ON "media_cleanup_protections"("mediaShowId");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_mediaLibraryId_idx" ON "media_cleanup_protections"("mediaLibraryId");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_externalIdentityKey_idx" ON "media_cleanup_protections"("externalIdentityKey");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_protectedUntil_idx" ON "media_cleanup_protections"("protectedUntil");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_targetType_revokedAt_idx" ON "media_cleanup_protections"("targetType", "revokedAt");

-- CreateIndex
CREATE INDEX "media_cleanup_protections_revokedAt_idx" ON "media_cleanup_protections"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "media_cleanup_quarantine_items_quarantinePath_key" ON "media_cleanup_quarantine_items"("quarantinePath");

-- CreateIndex
CREATE INDEX "media_cleanup_quarantine_items_status_restoreDeadline_idx" ON "media_cleanup_quarantine_items"("status", "restoreDeadline");

-- CreateIndex
CREATE INDEX "media_cleanup_quarantine_items_mediaFileId_idx" ON "media_cleanup_quarantine_items"("mediaFileId");

-- CreateIndex
CREATE INDEX "media_cleanup_quarantine_items_planId_idx" ON "media_cleanup_quarantine_items"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "media_playback_aggregates_mediaItemId_key" ON "media_playback_aggregates"("mediaItemId");

-- CreateIndex
CREATE INDEX "media_playback_aggregates_completedPlayCount_idx" ON "media_playback_aggregates"("completedPlayCount");

-- CreateIndex
CREATE INDEX "media_playback_aggregates_lastPlayedAt_idx" ON "media_playback_aggregates"("lastPlayedAt");

-- CreateIndex
CREATE INDEX "media_playback_aggregates_computedAt_idx" ON "media_playback_aggregates"("computedAt");

-- AddForeignKey
ALTER TABLE "media_cleanup_policy_versions" ADD CONSTRAINT "media_cleanup_policy_versions_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "media_cleanup_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_cleanup_runs" ADD CONSTRAINT "media_cleanup_runs_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "media_cleanup_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_cleanup_runs" ADD CONSTRAINT "media_cleanup_runs_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "media_cleanup_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_cleanup_candidates" ADD CONSTRAINT "media_cleanup_candidates_runId_fkey" FOREIGN KEY ("runId") REFERENCES "media_cleanup_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_cleanup_plans" ADD CONSTRAINT "media_cleanup_plans_runId_fkey" FOREIGN KEY ("runId") REFERENCES "media_cleanup_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_cleanup_actions" ADD CONSTRAINT "media_cleanup_actions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "media_cleanup_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_playback_aggregates" ADD CONSTRAINT "media_playback_aggregates_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

