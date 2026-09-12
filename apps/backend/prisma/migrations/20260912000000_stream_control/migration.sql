-- Concurrent Stream Control (Phase 2): the canonical enforcement subject, the
-- policy-override table, and the enforcement-event history. Hand-written and
-- applied with `prisma migrate deploy` — never a shadow-db diff against a live
-- DATABASE_URL, which resets its target.

-- The canonical enforcement subject: (product id-space, stable provider user id).
CREATE TABLE "media_analytics_users" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "exemptFromLimits" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_analytics_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_analytics_users_kind_providerUserId_key"
    ON "media_analytics_users" ("kind", "providerUserId");

CREATE INDEX "media_analytics_users_groupId_idx"
    ON "media_analytics_users" ("groupId");

-- A policy OVERRIDE (the global default lives in settings).
CREATE TABLE "media_stream_policies" (
    "id" TEXT NOT NULL,
    "mediaAnalyticsUserId" TEXT,
    "mediaServerId" TEXT,
    "maxConcurrentStreams" INTEGER,
    "enforcementAction" TEXT,
    "gracePeriodSeconds" INTEGER,
    "countPaused" BOOLEAN,
    "scope" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_stream_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_stream_policies_mediaAnalyticsUserId_key"
    ON "media_stream_policies" ("mediaAnalyticsUserId");

CREATE INDEX "media_stream_policies_mediaServerId_idx"
    ON "media_stream_policies" ("mediaServerId");

ALTER TABLE "media_stream_policies"
    ADD CONSTRAINT "media_stream_policies_mediaAnalyticsUserId_fkey"
    FOREIGN KEY ("mediaAnalyticsUserId") REFERENCES "media_analytics_users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Operational history of enforcement decisions (NOT the audit log).
CREATE TABLE "media_stream_enforcement_events" (
    "id" TEXT NOT NULL,
    "mediaAnalyticsUserId" TEXT,
    "mediaServerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT,
    "providerSessionId" TEXT NOT NULL,
    "mediaTitle" TEXT,
    "client" TEXT,
    "device" TEXT,
    "ipAddress" TEXT,
    "configuredLimit" INTEGER NOT NULL,
    "observedStreams" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "errorMessage" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enforcedAt" TIMESTAMP(3),

    CONSTRAINT "media_stream_enforcement_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "media_stream_enforcement_events_mediaAnalyticsUserId_idx"
    ON "media_stream_enforcement_events" ("mediaAnalyticsUserId");

CREATE INDEX "media_stream_enforcement_events_detectedAt_idx"
    ON "media_stream_enforcement_events" ("detectedAt");
