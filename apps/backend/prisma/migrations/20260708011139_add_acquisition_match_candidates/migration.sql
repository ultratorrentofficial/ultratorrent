-- AlterTable
ALTER TABLE "media_acquisition_watchlist_items" ADD COLUMN     "rssRuleId" TEXT;

-- CreateTable
CREATE TABLE "acquisition_match_candidates" (
    "id" TEXT NOT NULL,
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
    "lastMatchedAt" TIMESTAMP(3),
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_match_candidates_pkey" PRIMARY KEY ("id")
);
