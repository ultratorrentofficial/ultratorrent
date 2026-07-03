-- CreateTable
CREATE TABLE "fleet_nodes" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT,
    "version" TEXT,
    "publicUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "customerId" TEXT,
    "groupId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_node_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_group_members" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_node_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_credentials" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "credentialHash" TEXT,
    "certificateFingerprint" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "fleet_node_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_health" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "healthScore" INTEGER,
    "cpu" JSONB,
    "memory" JSONB,
    "storage" JSONB,
    "engines" JSONB,
    "modules" JSONB,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_node_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_commands" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB,
    "result" JSONB,
    "issuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "fleet_node_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_node_audit_events" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_node_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "policyType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_policy_assignments" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "nodeId" TEXT,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_nodes_nodeId_key" ON "fleet_nodes"("nodeId");

-- CreateIndex
CREATE INDEX "fleet_nodes_status_idx" ON "fleet_nodes"("status");

-- CreateIndex
CREATE INDEX "fleet_nodes_groupId_idx" ON "fleet_nodes"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_node_groups_name_key" ON "fleet_node_groups"("name");

-- CreateIndex
CREATE INDEX "fleet_node_group_members_groupId_idx" ON "fleet_node_group_members"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_node_group_members_nodeId_groupId_key" ON "fleet_node_group_members"("nodeId", "groupId");

-- CreateIndex
CREATE INDEX "fleet_node_credentials_nodeId_idx" ON "fleet_node_credentials"("nodeId");

-- CreateIndex
CREATE INDEX "fleet_node_health_nodeId_idx" ON "fleet_node_health"("nodeId");

-- CreateIndex
CREATE INDEX "fleet_node_health_createdAt_idx" ON "fleet_node_health"("createdAt");

-- CreateIndex
CREATE INDEX "fleet_node_commands_nodeId_idx" ON "fleet_node_commands"("nodeId");

-- CreateIndex
CREATE INDEX "fleet_node_commands_status_idx" ON "fleet_node_commands"("status");

-- CreateIndex
CREATE INDEX "fleet_node_audit_events_nodeId_idx" ON "fleet_node_audit_events"("nodeId");

-- CreateIndex
CREATE INDEX "fleet_node_audit_events_createdAt_idx" ON "fleet_node_audit_events"("createdAt");

-- CreateIndex
CREATE INDEX "fleet_policy_assignments_policyId_idx" ON "fleet_policy_assignments"("policyId");
