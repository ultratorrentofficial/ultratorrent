-- Provenance for the Universal scraper: which provider supplied each field.
-- Null for every record written by a single provider, which is all of them today.
ALTER TABLE "media_metadata" ADD COLUMN "fieldSources" JSONB;
