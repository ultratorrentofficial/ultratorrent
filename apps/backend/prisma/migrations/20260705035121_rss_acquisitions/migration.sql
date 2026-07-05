-- CreateTable
CREATE TABLE "rss_acquisitions" (
    "id" TEXT NOT NULL,
    "rssRuleId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "priorityOrder" INTEGER NOT NULL,
    "releaseTitle" TEXT NOT NULL,
    "torrentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rss_acquisitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rss_acquisitions_rssRuleId_identity_key" ON "rss_acquisitions"("rssRuleId", "identity");

-- AddForeignKey
ALTER TABLE "rss_acquisitions" ADD CONSTRAINT "rss_acquisitions_rssRuleId_fkey" FOREIGN KEY ("rssRuleId") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
