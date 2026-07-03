-- CreateTable
CREATE TABLE "rss_smart_match_templates" (
    "id" TEXT NOT NULL,
    "rssRuleId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "parsedMetadata" JSONB NOT NULL,
    "generatedCandidates" JSONB NOT NULL,
    "confidenceScore" INTEGER NOT NULL DEFAULT 0,
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rss_smart_match_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rss_smart_match_templates_rssRuleId_idx" ON "rss_smart_match_templates"("rssRuleId");

-- AddForeignKey
ALTER TABLE "rss_smart_match_templates" ADD CONSTRAINT "rss_smart_match_templates_rssRuleId_fkey" FOREIGN KEY ("rssRuleId") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
