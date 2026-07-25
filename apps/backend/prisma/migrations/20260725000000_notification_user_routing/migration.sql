-- Per-recipient routing profiles + admin-forced rules.
--
-- Additive only: no existing column changes meaning, and with no routing rows and
-- `forced=false` everywhere the delivery pipeline behaves exactly as before.

-- A rule whose channels a recipient's profile may not override (security/system alerts).
ALTER TABLE "notification_rules" ADD COLUMN "forced" BOOLEAN NOT NULL DEFAULT false;

-- "Send me THIS event on THESE channels" — positive routing, which
-- notification_preferences (opt-out only) cannot express.
CREATE TABLE "notification_routings" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    -- exact event, a namespace wildcard ("system.*"), or "*"
    "event" TEXT NOT NULL,
    "channelIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_routings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_routings_recipientId_event_key" ON "notification_routings"("recipientId", "event");
CREATE INDEX "notification_routings_recipientId_idx" ON "notification_routings"("recipientId");
