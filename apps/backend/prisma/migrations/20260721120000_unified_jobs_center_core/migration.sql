-- CreateTable
CREATE TABLE "platform_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "moduleKey" TEXT NOT NULL,
    "workspaceKey" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceId" TEXT,
    "correlationId" TEXT,
    "parentJobId" TEXT,
    "rootJobId" TEXT,
    "scheduleId" TEXT,
    "workflowExecutionId" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "libraryId" TEXT,
    "mediaItemId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressCurrent" INTEGER,
    "progressTotal" INTEGER,
    "progressUnit" TEXT,
    "statusMessageKey" TEXT,
    "statusMessageParams" JSONB,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "queueName" TEXT,
    "workerId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "retryPolicy" JSONB,
    "retryAt" TIMESTAMP(3),
    "timeoutSeconds" INTEGER,
    "cancellable" BOOLEAN NOT NULL DEFAULT false,
    "pausable" BOOLEAN NOT NULL DEFAULT false,
    "resumable" BOOLEAN NOT NULL DEFAULT false,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "checkpointVersion" INTEGER,
    "checkpoint" JSONB,
    "createdById" TEXT,
    "runAsUserId" TEXT,
    "requiredPermission" TEXT,
    "visibilityScope" TEXT NOT NULL DEFAULT 'module',
    "inputSummary" JSONB,
    "resultSummary" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "warnings" JSONB,
    "metrics" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_job_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "eventType" TEXT NOT NULL,
    "messageKey" TEXT,
    "messageParams" JSONB,
    "sanitizedMessage" TEXT,
    "progress" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_jobs_status_createdAt_idx" ON "platform_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "platform_jobs_status_priority_queuedAt_idx" ON "platform_jobs"("status", "priority", "queuedAt");

-- CreateIndex
CREATE INDEX "platform_jobs_workspaceKey_status_idx" ON "platform_jobs"("workspaceKey", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_moduleKey_status_idx" ON "platform_jobs"("moduleKey", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_type_status_idx" ON "platform_jobs"("type", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_createdById_createdAt_idx" ON "platform_jobs"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "platform_jobs_parentJobId_idx" ON "platform_jobs"("parentJobId");

-- CreateIndex
CREATE INDEX "platform_jobs_rootJobId_idx" ON "platform_jobs"("rootJobId");

-- CreateIndex
CREATE INDEX "platform_jobs_correlationId_idx" ON "platform_jobs"("correlationId");

-- CreateIndex
CREATE INDEX "platform_jobs_workerId_status_idx" ON "platform_jobs"("workerId", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_scheduledFor_status_idx" ON "platform_jobs"("scheduledFor", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_heartbeatAt_status_idx" ON "platform_jobs"("heartbeatAt", "status");

-- CreateIndex
CREATE INDEX "platform_jobs_scheduleId_idx" ON "platform_jobs"("scheduleId");

-- CreateIndex
CREATE INDEX "platform_jobs_idempotencyKey_idx" ON "platform_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "platform_job_events_jobId_createdAt_idx" ON "platform_job_events"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_job_events_level_idx" ON "platform_job_events"("level");

-- CreateIndex
CREATE INDEX "platform_job_events_eventType_idx" ON "platform_job_events"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "platform_job_events_jobId_sequence_key" ON "platform_job_events"("jobId", "sequence");

-- AddForeignKey
ALTER TABLE "platform_jobs" ADD CONSTRAINT "platform_jobs_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "platform_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_job_events" ADD CONSTRAINT "platform_job_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "platform_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
