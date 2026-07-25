-- Assembled digests, recorded so the worker is idempotent across restarts: a
-- duplicate digest is far more annoying than a late one.
CREATE TABLE "notification_digests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- daily | weekly
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "overflow" INTEGER NOT NULL DEFAULT 0,
    -- pending | sent | empty
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_digests_pkey" PRIMARY KEY ("id")
);
-- The idempotency guarantee: one digest per user, kind and period.
CREATE UNIQUE INDEX "notification_digests_userId_kind_periodEnd_key" ON "notification_digests"("userId", "kind", "periodEnd");
CREATE INDEX "notification_digests_userId_createdAt_idx" ON "notification_digests"("userId", "createdAt");
