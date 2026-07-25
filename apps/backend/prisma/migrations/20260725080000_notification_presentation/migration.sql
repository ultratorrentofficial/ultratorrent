-- Store the rendered rich card on each notification.
--
-- Rendered per recipient, already authorized and already redacted, then frozen.
-- Rebuilding it at read time would let a catalogue change silently rewrite what
-- a historical notification said.
--
-- `artConnectionId` / `artPath` let a stopped-playback card still resolve a
-- poster after its live session row is deleted. Neither is a URL — the path is
-- only fetchable through that connection's stored credentials.
ALTER TABLE "user_notifications" ADD COLUMN "presentation" JSONB;
ALTER TABLE "user_notifications" ADD COLUMN "artConnectionId" TEXT;
ALTER TABLE "user_notifications" ADD COLUMN "artPath" TEXT;
