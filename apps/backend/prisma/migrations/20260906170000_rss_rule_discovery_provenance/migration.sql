-- Media Discovery provenance on RSS rules.
--
-- Purely additive. `generatedByDiscovery` defaults to FALSE so every rule that
-- exists today stays a hand-made rule and keeps behaving exactly as it does —
-- the same precedent `importMode` set when managed intake was introduced.
ALTER TABLE "rss_rules"
  ADD COLUMN "generatedByDiscovery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "discoveryTemplateId" TEXT,
  ADD COLUMN "acquisitionTemplateId" TEXT,
  ADD COLUMN "discoveredMediaId" TEXT,
  ADD COLUMN "acquisitionTemplateVersion" INTEGER,
  ADD COLUMN "userModifiedAt" TIMESTAMP(3);

-- The Discover UI lists generated rules; nothing else filters on this.
CREATE INDEX "rss_rules_generatedByDiscovery_idx" ON "rss_rules"("generatedByDiscovery");
