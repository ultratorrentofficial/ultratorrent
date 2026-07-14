-- Operator lock: protects an item from re-identification, re-enrichment and the
-- renamer. Defaults false so every existing row keeps today's behaviour.
ALTER TABLE "media_items" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
