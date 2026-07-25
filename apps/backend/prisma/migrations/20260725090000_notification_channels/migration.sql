-- Personal channel connections and delivery tracking.
--
-- One active connection per (user, type). The unique constraint is what keeps
-- the first release simple; dropping it is all a multi-destination future needs.

CREATE TABLE "user_notification_channels" (
    "id"                  TEXT NOT NULL,
    "userId"              TEXT NOT NULL,
    "type"                TEXT NOT NULL,
    "enabled"             BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt"          TIMESTAMP(3),
    "encryptedConfig"     JSONB NOT NULL,
    "maskedDestination"   TEXT,
    "lastTestedAt"        TIMESTAMP(3),
    "lastSuccessAt"       TIMESTAMP(3),
    "lastFailureAt"       TIMESTAMP(3),
    "lastError"           TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "deletedAt"           TIMESTAMP(3),
    CONSTRAINT "user_notification_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_notification_channels_userId_type_key"
    ON "user_notification_channels"("userId", "type");
CREATE INDEX "user_notification_channels_userId_enabled_idx"
    ON "user_notification_channels"("userId", "enabled");

CREATE TABLE "user_notification_deliveries" (
    "id"               TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "notificationId"   TEXT,
    "eventKey"         TEXT NOT NULL,
    "channelType"      TEXT NOT NULL,
    "channelId"        TEXT,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt"    TIMESTAMP(3),
    "lastError"        TEXT,
    "suppressedReason" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt"           TIMESTAMP(3),
    "completedAt"      TIMESTAMP(3),
    CONSTRAINT "user_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- Idempotency: one delivery per (notification, channel). A redelivered event
-- collides here instead of sending the same person the same mail twice.
CREATE UNIQUE INDEX "user_notification_deliveries_notificationId_channelType_key"
    ON "user_notification_deliveries"("notificationId", "channelType");
-- Backs the worker's "what is due" sweep.
CREATE INDEX "user_notification_deliveries_status_nextAttemptAt_idx"
    ON "user_notification_deliveries"("status", "nextAttemptAt");
CREATE INDEX "user_notification_deliveries_userId_createdAt_idx"
    ON "user_notification_deliveries"("userId", "createdAt");

ALTER TABLE "user_notification_channels"
    ADD CONSTRAINT "user_notification_channels_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_notification_deliveries"
    ADD CONSTRAINT "user_notification_deliveries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
