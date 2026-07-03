-- CreateTable
CREATE TABLE "white_label_configs" (
    "id" TEXT NOT NULL,
    "productName" TEXT,
    "accentColor" TEXT,
    "footerText" TEXT,
    "supportUrl" TEXT,
    "logo" TEXT,
    "loginBackground" TEXT,
    "emailBranding" JSONB,
    "portalBranding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "white_label_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "central_backup_records" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "backupType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "location" TEXT,
    "checksum" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "central_backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "central_backup_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT,
    "retention" JSONB,
    "scope" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "central_backup_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "central_update_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scope" JSONB,
    "strategy" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "central_update_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "central_update_node_statuses" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentVersion" TEXT,
    "targetVersion" TEXT,
    "result" JSONB,
    "errorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "central_update_node_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "central_backup_records_nodeId_idx" ON "central_backup_records"("nodeId");

-- CreateIndex
CREATE INDEX "central_backup_records_status_idx" ON "central_backup_records"("status");

-- CreateIndex
CREATE INDEX "central_update_campaigns_status_idx" ON "central_update_campaigns"("status");

-- CreateIndex
CREATE INDEX "central_update_node_statuses_campaignId_idx" ON "central_update_node_statuses"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "central_update_node_statuses_campaignId_nodeId_key" ON "central_update_node_statuses"("campaignId", "nodeId");
