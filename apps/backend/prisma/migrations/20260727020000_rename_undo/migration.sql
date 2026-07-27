-- Run grouping and undo bookkeeping for the rename engine.
--
-- `runId` groups every operation of one apply so an undo reverses a run rather
-- than a single file. `undoneAt` makes undo idempotent: a second attempt is a
-- no-op instead of moving a file back to where it is not.
ALTER TABLE "media_rename_operations" ADD COLUMN "runId" TEXT;
ALTER TABLE "media_rename_operations" ADD COLUMN "undoneAt" TIMESTAMP(3);
CREATE INDEX "media_rename_operations_runId_idx" ON "media_rename_operations"("runId");
