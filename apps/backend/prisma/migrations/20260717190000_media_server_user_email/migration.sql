-- Media-server users can now carry an email address, so a synced viewer can be
-- offered as a newsletter recipient without retyping their address.
--
-- Plex accounts have an email (fetched from plex.tv); Jellyfin/Emby user models
-- have no email field, so the column stays null for those providers. Nullable and
-- additive — no existing data is touched.

-- AlterTable
ALTER TABLE "media_server_users" ADD COLUMN "email" TEXT;
