-- The file's own modification time, read during a scan.
--
-- Cleanup policies ask "how long have I had this". The only date available was
-- `media_files.createdAt` / `media_items.createdAt`, which record when
-- UltraTorrent first SCANNED the file — so on any library that predates the
-- install every item looks days old however long it has really been held. On a
-- live host the oldest row was 41 days against media going back years, and a
-- policy asking for "added over a year ago" could not match a single item, and
-- would not have until 2027.
--
-- Nullable and additive: a row written before this has no mtime until its next
-- scan, and the fact assembly falls back to the row's creation date meanwhile,
-- which is exactly the behaviour that existed before.
ALTER TABLE "media_files" ADD COLUMN "modifiedAt" TIMESTAMP(3);

-- Age queries read this column across a whole library at once.
CREATE INDEX "media_files_modifiedAt_idx" ON "media_files" ("modifiedAt");
