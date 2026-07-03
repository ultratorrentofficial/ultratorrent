-- CreateTable
CREATE TABLE "media_acquisition_watchlist_items" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "year" INTEGER,
    "externalIds" JSONB,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "collectionName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "profileId" TEXT,
    "targetLibraryId" TEXT,
    "settings" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_acquisition_watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_acquisition_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mediaType" TEXT NOT NULL,
    "minimumScore" INTEGER NOT NULL DEFAULT 0,
    "approvalScore" INTEGER NOT NULL DEFAULT 0,
    "minimumResolution" TEXT,
    "preferredResolution" TEXT,
    "preferredSource" TEXT,
    "preferredCodec" TEXT,
    "preferredAudio" TEXT,
    "preferredHdr" TEXT,
    "preferredLanguages" JSONB,
    "requiredTerms" JSONB,
    "excludedTerms" JSONB,
    "preferredGroups" JSONB,
    "qualityRules" JSONB,
    "duplicateRules" JSONB,
    "storageRules" JSONB,
    "automationRules" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_acquisition_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_acquisition_evaluations" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "releaseName" TEXT NOT NULL,
    "parsedMetadata" JSONB,
    "watchlistItemId" TEXT,
    "profileId" TEXT,
    "libraryMatch" JSONB,
    "releaseScore" JSONB,
    "duplicateRisk" JSONB,
    "qualityGap" JSONB,
    "storageCheck" JSONB,
    "serverSelection" JSONB,
    "decision" TEXT NOT NULL,
    "decisionReason" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalStatus" TEXT NOT NULL DEFAULT 'not_required',
    "actionTaken" TEXT,
    "torrentHash" TEXT,
    "trace" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_acquisition_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_acquisition_actions" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB,
    "result" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "media_acquisition_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_acquisition_history" (
    "id" TEXT NOT NULL,
    "watchlistItemId" TEXT,
    "evaluationId" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_acquisition_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_acquisition_watchlist_items_status_idx" ON "media_acquisition_watchlist_items"("status");

-- CreateIndex
CREATE INDEX "media_acquisition_watchlist_items_normalizedTitle_idx" ON "media_acquisition_watchlist_items"("normalizedTitle");

-- CreateIndex
CREATE INDEX "media_acquisition_evaluations_decision_idx" ON "media_acquisition_evaluations"("decision");

-- CreateIndex
CREATE INDEX "media_acquisition_evaluations_approvalStatus_idx" ON "media_acquisition_evaluations"("approvalStatus");

-- CreateIndex
CREATE INDEX "media_acquisition_evaluations_createdAt_idx" ON "media_acquisition_evaluations"("createdAt");

-- CreateIndex
CREATE INDEX "media_acquisition_actions_evaluationId_idx" ON "media_acquisition_actions"("evaluationId");

-- CreateIndex
CREATE INDEX "media_acquisition_history_watchlistItemId_idx" ON "media_acquisition_history"("watchlistItemId");

-- CreateIndex
CREATE INDEX "media_acquisition_history_createdAt_idx" ON "media_acquisition_history"("createdAt");

-- AddForeignKey
ALTER TABLE "media_acquisition_actions" ADD CONSTRAINT "media_acquisition_actions_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "media_acquisition_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
