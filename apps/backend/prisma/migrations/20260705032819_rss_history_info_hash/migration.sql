-- AlterTable
ALTER TABLE "rss_history" ADD COLUMN     "infoHash" TEXT;

-- CreateIndex
CREATE INDEX "rss_history_infoHash_idx" ON "rss_history"("infoHash");
