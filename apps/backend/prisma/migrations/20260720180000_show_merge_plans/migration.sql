-- Duplicate SHOW FOLDER merges become persisted, approvable plans.
--
-- Until now `merge` recomputed its plan at execute time, so an operator approved a
-- preview and the server ran whatever the disk looked like a moment later. Show
-- merges now go through the same store-then-execute path duplicate FILE cleanups
-- already use, which is why they land in this table rather than a parallel one.
--
-- Purely additive: `groupId` loses NOT NULL (a show merge has no group), every new
-- column is nullable or defaulted, and existing rows keep scope 'group'.

ALTER TABLE "media_duplicate_resolutions" ALTER COLUMN "groupId" DROP NOT NULL;

ALTER TABLE "media_duplicate_resolutions"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'group',
  ADD COLUMN "canonicalShowId" TEXT,
  ADD COLUMN "inputFingerprint" TEXT;

CREATE INDEX "media_duplicate_resolutions_canonicalShowId_idx"
  ON "media_duplicate_resolutions" ("canonicalShowId");
CREATE INDEX "media_duplicate_resolutions_scope_idx"
  ON "media_duplicate_resolutions" ("scope");
