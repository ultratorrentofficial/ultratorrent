-- A locally-set friendly name for a synced media-server user.
--
-- Nullable and additive: existing rows keep showing the synced `userName`, and
-- nothing has to be backfilled. The sync path never writes this column, so an
-- operator's name survives every later sync.
ALTER TABLE "media_server_users" ADD COLUMN "displayName" TEXT;
