-- Items held back from a newsletter issue by pre-send verification, carried to
-- the next issue so a film with no artwork is delayed rather than dropped.
ALTER TABLE "media_server_newsletters"
  ADD COLUMN "deferredItems" JSONB NOT NULL DEFAULT '[]';
