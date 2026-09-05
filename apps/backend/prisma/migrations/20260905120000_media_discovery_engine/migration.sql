-- CreateTable
CREATE TABLE "discovered_media" (
    "id" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "originalTitle" TEXT,
    "normalizedTitle" TEXT NOT NULL,
    "year" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "externalIds" JSONB NOT NULL DEFAULT '{}',
    "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "originalLanguage" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "network" TEXT,
    "studio" TEXT,
    "streamingService" TEXT,
    "overview" TEXT,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "popularity" DOUBLE PRECISION,
    "rating" DOUBLE PRECISION,
    "voteCount" INTEGER,
    "seriesStatus" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "premiereDate" TIMESTAMP(3),
    "seasonPremiereDate" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "sourceProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discoveryStatus" TEXT NOT NULL DEFAULT 'new',
    "identityStatus" TEXT NOT NULL DEFAULT 'resolved',
    "decision" TEXT,
    "decisionReason" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "matchedTemplateId" TEXT,
    "watchlistItemId" TEXT,
    "rssRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovered_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovered_media_release_dates" (
    "id" TEXT NOT NULL,
    "discoveredMediaId" TEXT NOT NULL,
    "releaseType" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "region" TEXT,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovered_media_release_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mediaType" TEXT NOT NULL DEFAULT 'any',
    "providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "upcomingWindowDays" INTEGER NOT NULL DEFAULT 90,
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minimumPopularity" DOUBLE PRECISION,
    "minimumRating" DOUBLE PRECISION,
    "minimumVoteCount" INTEGER,
    "networks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "streamingServices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "studios" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seriesTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "releaseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoMonitorCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifyOnlyCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ignoreCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedFromAutoCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryMatchMode" TEXT NOT NULL DEFAULT 'ANY',
    "minimumConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "acquisitionTemplateId" TEXT,
    "rssFeedId" TEXT,
    "storageProfileId" TEXT,
    "pathTemplate" TEXT,
    "createIntakeDirectory" BOOLEAN NOT NULL DEFAULT false,
    "autoAddLimitPerDay" INTEGER NOT NULL DEFAULT 10,
    "autoAddLimitPerWeek" INTEGER NOT NULL DEFAULT 30,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_rule_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mediaType" TEXT NOT NULL DEFAULT 'any',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rssFeedId" TEXT,
    "storageProfileId" TEXT,
    "pathTemplate" TEXT,
    "requiredTerms" JSONB NOT NULL DEFAULT '[]',
    "excludedTerms" JSONB NOT NULL DEFAULT '[]',
    "upgradePolicy" TEXT NOT NULL DEFAULT 'inherit',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_rule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_rule_template_candidates" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "priorityOrder" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "matchType" TEXT NOT NULL DEFAULT 'smart_episode_match',
    "pattern" TEXT,
    "requiredTerms" JSONB NOT NULL DEFAULT '[]',
    "excludedTerms" JSONB NOT NULL DEFAULT '[]',
    "qualityRules" JSONB NOT NULL DEFAULT '{}',
    "sizeRules" JSONB NOT NULL DEFAULT '{}',
    "feedScope" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_rule_template_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_evaluations" (
    "id" TEXT NOT NULL,
    "discoveredMediaId" TEXT NOT NULL,
    "templateId" TEXT,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "watchlistItemId" TEXT,
    "rssRuleId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_provider_state" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "healthy" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSuccessfulSync" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "lastResponseMs" INTEGER,
    "itemsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncCursors" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_provider_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discovered_media_dedupeKey_key" ON "discovered_media"("dedupeKey");

-- CreateIndex
CREATE INDEX "discovered_media_mediaType_discoveryStatus_idx" ON "discovered_media"("mediaType", "discoveryStatus");

-- CreateIndex
CREATE INDEX "discovered_media_normalizedTitle_idx" ON "discovered_media"("normalizedTitle");

-- CreateIndex
CREATE INDEX "discovered_media_decision_idx" ON "discovered_media"("decision");

-- CreateIndex
CREATE INDEX "discovered_media_lastSeenAt_idx" ON "discovered_media"("lastSeenAt");

-- CreateIndex
CREATE INDEX "discovered_media_year_idx" ON "discovered_media"("year");

-- CreateIndex
CREATE INDEX "discovered_media_release_dates_date_idx" ON "discovered_media_release_dates"("date");

-- CreateIndex
CREATE UNIQUE INDEX "discovered_media_release_dates_discoveredMediaId_releaseTyp_key" ON "discovered_media_release_dates"("discoveredMediaId", "releaseType", "region", "source");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_templates_name_key" ON "discovery_templates"("name");

-- CreateIndex
CREATE INDEX "discovery_templates_enabled_idx" ON "discovery_templates"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_rule_templates_name_key" ON "acquisition_rule_templates"("name");

-- CreateIndex
CREATE INDEX "acquisition_rule_template_candidates_templateId_idx" ON "acquisition_rule_template_candidates"("templateId");

-- CreateIndex
CREATE INDEX "discovery_evaluations_discoveredMediaId_createdAt_idx" ON "discovery_evaluations"("discoveredMediaId", "createdAt");

-- CreateIndex
CREATE INDEX "discovery_evaluations_decision_idx" ON "discovery_evaluations"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_provider_state_provider_key" ON "discovery_provider_state"("provider");

-- RenameForeignKey
ALTER TABLE "media_artwork" RENAME CONSTRAINT "media_artwork_owner_fkey" TO "media_artwork_showId_fkey";

-- AddForeignKey
ALTER TABLE "discovered_media_release_dates" ADD CONSTRAINT "discovered_media_release_dates_discoveredMediaId_fkey" FOREIGN KEY ("discoveredMediaId") REFERENCES "discovered_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_rule_template_candidates" ADD CONSTRAINT "acquisition_rule_template_candidates_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "acquisition_rule_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_evaluations" ADD CONSTRAINT "discovery_evaluations_discoveredMediaId_fkey" FOREIGN KEY ("discoveredMediaId") REFERENCES "discovered_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_evaluations" ADD CONSTRAINT "discovery_evaluations_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "discovery_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "media_duplicate_groups_status_requiresReview_savings_idx" RENAME TO "media_duplicate_groups_status_requiresReview_potentialSavin_idx";

