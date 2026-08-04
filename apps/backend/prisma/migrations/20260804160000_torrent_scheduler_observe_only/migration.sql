-- Torrent Activity Scheduler — Observe Only.
--
-- Adds the scheduler's own state. It changes NO existing table and touches no
-- torrent: every engine begins in `native` mode, which is exactly today's
-- behaviour, and nothing here can alter a torrent's activity.
--
-- The default is the whole point. An upgrade must never enrol an existing
-- installation into a scheduler it did not ask for, so the absence of a row and
-- the presence of a `native` row mean the same thing, and both mean "leave the
-- engine alone".

-- How UltraTorrent relates to one engine's queue.
CREATE TABLE "torrent_scheduler_engine_configs" (
    "engineId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'native',
    "modeChangedAt" TIMESTAMP(3),
    "modeChangedBy" TEXT,
    "nativeSettingsSnapshot" JSONB,
    "nativeSettingsSnapshotAt" TIMESTAMP(3),
    "lastSweepAt" TIMESTAMP(3),
    "lastSuccessfulSweepAt" TIMESTAMP(3),
    "healthState" TEXT NOT NULL DEFAULT 'unknown',
    "healthDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "torrent_scheduler_engine_configs_pkey" PRIMARY KEY ("engineId")
);

-- Scheduling policies. NULL on a limit column means EXPLICITLY UNLIMITED; the
-- absence of a policy row at that scope means "inherit from the scope above".
-- Those are different answers, which is why unlimited is not encoded as -1.
CREATE TABLE "torrent_scheduler_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "maxConcurrentDownloads" INTEGER,
    "maxConcurrentSeeds" INTEGER,
    "maxTotalActive" INTEGER,
    "maxDownloadRateKbps" INTEGER,
    "maxUploadRateKbps" INTEGER,
    "reserveDownloadBandwidthPercent" INTEGER,
    "reserveSeedBandwidthPercent" INTEGER,
    "seedPolicy" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "torrent_scheduler_policies_pkey" PRIMARY KEY ("id")
);

-- One sweep's outcome, compact. A full torrent snapshot per sweep would write
-- megabytes to record that nothing changed.
CREATE TABLE "torrent_scheduler_decisions" (
    "id" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "limitations" JSONB,
    "proposedActions" INTEGER NOT NULL DEFAULT 0,
    "appliedActions" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "result" TEXT NOT NULL DEFAULT 'ok',

    CONSTRAINT "torrent_scheduler_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "torrent_scheduler_policies_scopeType_scopeId_name_key"
    ON "torrent_scheduler_policies"("scopeType", "scopeId", "name");

CREATE INDEX "torrent_scheduler_policies_enabled_scopeType_idx"
    ON "torrent_scheduler_policies"("enabled", "scopeType");

-- The history query is always "this engine, most recent first".
CREATE INDEX "torrent_scheduler_decisions_engineId_generatedAt_idx"
    ON "torrent_scheduler_decisions"("engineId", "generatedAt");
