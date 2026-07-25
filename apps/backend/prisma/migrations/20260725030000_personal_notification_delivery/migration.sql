-- Personal delivery pipeline: one row per user+event+route, its attempt log, and
-- dead letters. Additive; the legacy notification_deliveries table is untouched.

CREATE TABLE "user_notification_deliveries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT,
    "eventKey" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "channelId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorClass" TEXT,
    "suppressedReason" TEXT,
    "dedupeKey" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "user_notification_deliveries_pkey" PRIMARY KEY ("id")
);
-- Idempotency: a redelivered bus event must not enqueue the same delivery twice.
CREATE UNIQUE INDEX "user_notification_deliveries_userId_dedupeKey_key" ON "user_notification_deliveries"("userId", "dedupeKey");
-- The retry worker's claim query.
CREATE INDEX "user_notification_deliveries_status_nextAttemptAt_idx" ON "user_notification_deliveries"("status", "nextAttemptAt");
CREATE INDEX "user_notification_deliveries_userId_eventKey_idx" ON "user_notification_deliveries"("userId", "eventKey");
CREATE INDEX "user_notification_deliveries_channelId_idx" ON "user_notification_deliveries"("channelId");

CREATE TABLE "user_notification_delivery_attempts" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorClass" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_notification_delivery_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_notification_delivery_attempts_deliveryId_idx" ON "user_notification_delivery_attempts"("deliveryId");

-- Retained after the delivery is cleaned up: "why did this never arrive" is
-- unanswerable if the evidence is deleted with the row.
CREATE TABLE "notification_dead_letters" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "errorClass" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_dead_letters_userId_createdAt_idx" ON "notification_dead_letters"("userId", "createdAt");

ALTER TABLE "user_notification_deliveries" ADD CONSTRAINT "user_notification_deliveries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_delivery_attempts" ADD CONSTRAINT "user_notification_delivery_attempts_deliveryId_fkey"
    FOREIGN KEY ("deliveryId") REFERENCES "user_notification_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
