-- Index the TorrentSnapshot foreign key so filtering snapshots by category and
-- deleting a category no longer seq-scan the largest, highest-churn table.
CREATE INDEX "torrent_snapshots_categoryId_idx" ON "torrent_snapshots"("categoryId");
