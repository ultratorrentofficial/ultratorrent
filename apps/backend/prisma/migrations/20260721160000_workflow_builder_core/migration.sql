-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workspaceKey" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentDraftVersionId" TEXT,
    "publishedVersionId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "graph" JSONB NOT NULL,
    "triggerSummary" JSONB,
    "requiredPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checksum" TEXT NOT NULL,
    "changeNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_executions" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "triggerType" TEXT,
    "triggerEventId" TEXT,
    "triggerSource" TEXT DEFAULT 'event',
    "correlationId" TEXT,
    "traceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "inputContext" JSONB,
    "outputSummary" JSONB,
    "currentNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jobId" TEXT,
    "executionIdentityUserId" TEXT,
    "resumeAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "parentExecutionId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_node_executions" (
    "id" TEXT NOT NULL,
    "workflowExecutionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "inputSummary" JSONB,
    "outputSummary" JSONB,
    "jobId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "warnings" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_node_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_approvals" (
    "id" TEXT NOT NULL,
    "workflowExecutionId" TEXT NOT NULL,
    "nodeExecutionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedFromUserId" TEXT,
    "requestedFromRoleId" TEXT,
    "requiredPermission" TEXT,
    "riskLevel" TEXT DEFAULT 'normal',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "respondedById" TEXT,
    "comment" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_variables" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'workflow',
    "workflowId" TEXT,
    "key" TEXT NOT NULL,
    "valueType" TEXT NOT NULL DEFAULT 'string',
    "encryptedValue" TEXT,
    "plainValue" JSONB,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "descriptionKey" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "graph" JSONB NOT NULL,
    "requiredModules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_status_idx" ON "workflows"("status");

-- CreateIndex
CREATE INDEX "workflows_enabled_idx" ON "workflows"("enabled");

-- CreateIndex
CREATE INDEX "workflows_workspaceKey_idx" ON "workflows"("workspaceKey");

-- CreateIndex
CREATE INDEX "workflows_updatedAt_idx" ON "workflows"("updatedAt");

-- CreateIndex
CREATE INDEX "workflow_versions_workflowId_idx" ON "workflow_versions"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_versions_status_idx" ON "workflow_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflowId_versionNumber_key" ON "workflow_versions"("workflowId", "versionNumber");

-- CreateIndex
CREATE INDEX "workflow_executions_status_createdAt_idx" ON "workflow_executions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_executions_workflowId_createdAt_idx" ON "workflow_executions"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_executions_workflowVersionId_idx" ON "workflow_executions"("workflowVersionId");

-- CreateIndex
CREATE INDEX "workflow_executions_correlationId_idx" ON "workflow_executions"("correlationId");

-- CreateIndex
CREATE INDEX "workflow_executions_status_resumeAt_idx" ON "workflow_executions"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "workflow_executions_status_expiresAt_idx" ON "workflow_executions"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "workflow_executions_heartbeatAt_status_idx" ON "workflow_executions"("heartbeatAt", "status");

-- CreateIndex
CREATE INDEX "workflow_executions_parentExecutionId_idx" ON "workflow_executions"("parentExecutionId");

-- CreateIndex
CREATE INDEX "workflow_node_executions_workflowExecutionId_nodeId_idx" ON "workflow_node_executions"("workflowExecutionId", "nodeId");

-- CreateIndex
CREATE INDEX "workflow_node_executions_status_idx" ON "workflow_node_executions"("status");

-- CreateIndex
CREATE INDEX "workflow_node_executions_jobId_idx" ON "workflow_node_executions"("jobId");

-- CreateIndex
CREATE INDEX "workflow_approvals_status_expiresAt_idx" ON "workflow_approvals"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "workflow_approvals_workflowExecutionId_idx" ON "workflow_approvals"("workflowExecutionId");

-- CreateIndex
CREATE INDEX "workflow_variables_scope_idx" ON "workflow_variables"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_variables_scope_workflowId_key_key" ON "workflow_variables"("scope", "workflowId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_key_key" ON "workflow_templates"("key");

-- CreateIndex
CREATE INDEX "workflow_templates_category_idx" ON "workflow_templates"("category");

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_executions" ADD CONSTRAINT "workflow_node_executions_workflowExecutionId_fkey" FOREIGN KEY ("workflowExecutionId") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_workflowExecutionId_fkey" FOREIGN KEY ("workflowExecutionId") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
