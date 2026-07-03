-- CreateTable
CREATE TABLE "rss_rule_match_candidates" (
    "id" TEXT NOT NULL,
    "rssRuleId" TEXT NOT NULL,
    "priorityOrder" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "matchType" TEXT NOT NULL,
    "pattern" TEXT,
    "requiredTerms" JSONB NOT NULL DEFAULT '[]',
    "excludedTerms" JSONB NOT NULL DEFAULT '[]',
    "qualityRules" JSONB NOT NULL DEFAULT '{}',
    "sizeRules" JSONB NOT NULL DEFAULT '{}',
    "feedScope" JSONB NOT NULL DEFAULT '{}',
    "lastMatchedAt" TIMESTAMP(3),
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rss_rule_match_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rss_rule_match_evaluations" (
    "id" TEXT NOT NULL,
    "rssRuleId" TEXT NOT NULL,
    "rssItemId" TEXT NOT NULL,
    "matchedCandidateId" TEXT,
    "matchedCandidatePriority" INTEGER,
    "result" TEXT NOT NULL,
    "evaluationTrace" JSONB NOT NULL,
    "actionTaken" TEXT,
    "torrentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rss_rule_match_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rss_rule_match_candidates_rssRuleId_idx" ON "rss_rule_match_candidates"("rssRuleId");

-- CreateIndex
CREATE INDEX "rss_rule_match_evaluations_rssRuleId_idx" ON "rss_rule_match_evaluations"("rssRuleId");

-- CreateIndex
CREATE INDEX "rss_rule_match_evaluations_rssItemId_idx" ON "rss_rule_match_evaluations"("rssItemId");

-- AddForeignKey
ALTER TABLE "rss_rule_match_candidates" ADD CONSTRAINT "rss_rule_match_candidates_rssRuleId_fkey" FOREIGN KEY ("rssRuleId") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rss_rule_match_evaluations" ADD CONSTRAINT "rss_rule_match_evaluations_rssRuleId_fkey" FOREIGN KEY ("rssRuleId") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
