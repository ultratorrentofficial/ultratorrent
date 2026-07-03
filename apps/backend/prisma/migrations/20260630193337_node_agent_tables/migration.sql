-- CreateTable
CREATE TABLE "node_identities" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeName" TEXT,
    "installId" TEXT NOT NULL,
    "productVersion" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'standalone',
    "publicUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_central_connections" (
    "id" TEXT NOT NULL,
    "centralUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unregistered',
    "nodeTokenHash" TEXT,
    "certificateFingerprint" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_central_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_heartbeats" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "health" JSONB,
    "storage" JSONB,
    "engines" JSONB,
    "modules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_remote_commands" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB,
    "result" JSONB,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "node_remote_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_agent_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_identities_nodeId_key" ON "node_identities"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "node_identities_installId_key" ON "node_identities"("installId");

-- CreateIndex
CREATE INDEX "node_heartbeats_nodeId_idx" ON "node_heartbeats"("nodeId");

-- CreateIndex
CREATE INDEX "node_heartbeats_createdAt_idx" ON "node_heartbeats"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "node_remote_commands_commandId_key" ON "node_remote_commands"("commandId");

-- CreateIndex
CREATE INDEX "node_remote_commands_status_idx" ON "node_remote_commands"("status");

-- CreateIndex
CREATE INDEX "node_remote_commands_createdAt_idx" ON "node_remote_commands"("createdAt");

-- CreateIndex
CREATE INDEX "node_agent_events_eventType_idx" ON "node_agent_events"("eventType");

-- CreateIndex
CREATE INDEX "node_agent_events_createdAt_idx" ON "node_agent_events"("createdAt");
