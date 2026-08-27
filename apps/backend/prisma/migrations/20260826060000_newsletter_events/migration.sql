-- Newsletters record what happened to them.
--
-- The audit log answers "who did what", and is written per USER action. It had
-- entries for creating, updating and sending a newsletter, and nothing for the
-- things that happen without a user: a scheduled dispatch, a per-recipient SMTP
-- refusal, a generation that found nothing worth sending. Those are exactly
-- what an operator is looking for when a newsletter did not arrive, so there
-- was no way to answer the question from inside the product.
--
-- Deliveries already record the per-recipient outcome, but only that, and only
-- per newsletter — nothing tied the recipients of one send together, or to the
-- generation that produced it.
CREATE TABLE "media_server_newsletter_events" (
    "id" TEXT NOT NULL,
    "newsletterId" TEXT,
    "runId" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "level" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "messageKey" TEXT,
    "messageParams" JSONB,
    "sanitizedMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_server_newsletter_events_pkey" PRIMARY KEY ("id")
);

-- The feed is always read newest-first for one newsletter, or across all of
-- them; both are covered by leading with the newsletter and then the time.
CREATE INDEX "media_server_newsletter_events_newsletterId_createdAt_idx"
    ON "media_server_newsletter_events"("newsletterId", "createdAt");

-- Expanding one entry fetches its run.
CREATE INDEX "media_server_newsletter_events_runId_idx"
    ON "media_server_newsletter_events"("runId");

CREATE INDEX "media_server_newsletter_events_eventType_idx"
    ON "media_server_newsletter_events"("eventType");

-- ON DELETE CASCADE: an event about a deleted newsletter describes something
-- that no longer exists and cannot be opened from the UI.
ALTER TABLE "media_server_newsletter_events"
    ADD CONSTRAINT "media_server_newsletter_events_newsletterId_fkey"
    FOREIGN KEY ("newsletterId") REFERENCES "media_server_newsletters"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
