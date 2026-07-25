-- Personal notifications, rebuilt.
--
-- Two tables, both owned by exactly one local user. The system these replace had
-- a nullable `userId` that was null for all 1,729 rows on a live install, which
-- made every in-app notification a broadcast to whoever was connected. Ownership
-- is enforced here by a NOT NULL column and a cascading FK, not by convention.

CREATE TABLE "user_notification_preferences" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "eventKey"        TEXT NOT NULL,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "inAppEnabled"    BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discordEnabled"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- One answer per user per event; the upsert target.
CREATE UNIQUE INDEX "user_notification_preferences_userId_eventKey_key"
    ON "user_notification_preferences"("userId", "eventKey");
CREATE INDEX "user_notification_preferences_userId_idx"
    ON "user_notification_preferences"("userId");

CREATE TABLE "user_notifications" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "eventId"      TEXT NOT NULL,
    "eventKey"     TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "severity"     TEXT NOT NULL DEFAULT 'info',
    "title"        TEXT NOT NULL,
    "body"         TEXT,
    "deepLink"     TEXT,
    "resourceType" TEXT,
    "resourceId"   TEXT,
    "readAt"       TIMESTAMP(3),
    "archivedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- (userId, eventId) is the idempotency guarantee: a redelivered domain event
-- collides here instead of notifying the same person twice.
CREATE UNIQUE INDEX "user_notifications_userId_eventId_key"
    ON "user_notifications"("userId", "eventId");
-- Backs the default inbox query (unread first, newest first) and the badge count.
CREATE INDEX "user_notifications_userId_readAt_createdAt_idx"
    ON "user_notifications"("userId", "readAt", "createdAt");
CREATE INDEX "user_notifications_userId_archivedAt_idx"
    ON "user_notifications"("userId", "archivedAt");

ALTER TABLE "user_notification_preferences"
    ADD CONSTRAINT "user_notification_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_notifications"
    ADD CONSTRAINT "user_notifications_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
