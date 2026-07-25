-- Distinguish "user cleared every destination" from "no routes stored, inherit the
-- catalogue default".
--
-- A scalar edit (changing only the delivery mode) creates a preference row with no
-- route rows, which is indistinguishable from a deliberate "send nowhere" unless the
-- intent is recorded. Without this flag one of the two silently becomes the other.
--
-- Backfill: any EXISTING preference row that already has route rows was necessarily
-- created by a route edit, so it is marked overridden; rows with none keep inheriting.
ALTER TABLE "user_notification_preferences" ADD COLUMN "routesOverridden" BOOLEAN NOT NULL DEFAULT false;

UPDATE "user_notification_preferences" p
SET "routesOverridden" = true
WHERE EXISTS (
  SELECT 1 FROM "user_notification_event_routes" r WHERE r."preferenceId" = p."id"
);
