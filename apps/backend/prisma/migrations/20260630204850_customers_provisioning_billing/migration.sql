-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_services" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "planId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "limits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_nodes" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_billing_accounts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCustomerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_provider_credentials" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "encryptedConfig" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "region" TEXT,
    "planRef" TEXT,
    "storageGb" INTEGER,
    "bandwidthTb" INTEGER,
    "priceMonthly" DECIMAL(65,30),
    "metadata" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_jobs" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "serviceId" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "region" TEXT,
    "planRef" TEXT,
    "serverId" TEXT,
    "nodeId" TEXT,
    "steps" JSONB,
    "errorMessage" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "provisioning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_provider_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "encryptedConfig" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "customerId" TEXT,
    "serviceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE INDEX "customer_services_customerId_idx" ON "customer_services"("customerId");

-- CreateIndex
CREATE INDEX "customer_nodes_nodeId_idx" ON "customer_nodes"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_nodes_customerId_nodeId_key" ON "customer_nodes"("customerId", "nodeId");

-- CreateIndex
CREATE INDEX "customer_billing_accounts_customerId_idx" ON "customer_billing_accounts"("customerId");

-- CreateIndex
CREATE INDEX "provisioning_provider_credentials_provider_idx" ON "provisioning_provider_credentials"("provider");

-- CreateIndex
CREATE INDEX "provisioning_plans_provider_idx" ON "provisioning_plans"("provider");

-- CreateIndex
CREATE INDEX "provisioning_jobs_status_idx" ON "provisioning_jobs"("status");

-- CreateIndex
CREATE INDEX "provisioning_jobs_customerId_idx" ON "provisioning_jobs"("customerId");

-- CreateIndex
CREATE INDEX "billing_provider_configs_provider_idx" ON "billing_provider_configs"("provider");

-- CreateIndex
CREATE INDEX "billing_events_eventType_idx" ON "billing_events"("eventType");

-- CreateIndex
CREATE INDEX "billing_events_customerId_idx" ON "billing_events"("customerId");

-- CreateIndex
CREATE INDEX "billing_events_createdAt_idx" ON "billing_events"("createdAt");
