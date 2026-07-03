-- DropForeignKey
ALTER TABLE "uplm_license_modules" DROP CONSTRAINT "uplm_license_modules_licenseId_fkey";

-- DropTable
DROP TABLE "uplm_installed_licenses";

-- DropTable
DROP TABLE "uplm_license_events";

-- DropTable
DROP TABLE "uplm_license_modules";

-- CreateTable
CREATE TABLE "license_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "state" TEXT NOT NULL DEFAULT 'not_configured',
    "certificate" JSONB,
    "signature" TEXT,
    "productKeyHash" TEXT,
    "productKeyEnc" TEXT,
    "maskedKey" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "subscriptionId" TEXT,
    "plan" TEXT,
    "licenseStatus" TEXT,
    "billingStatus" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "gracePeriodDays" INTEGER,
    "graceUntil" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "nextValidationAt" TIMESTAMP(3),
    "lastMessage" TEXT,
    "installId" TEXT NOT NULL,
    "fingerprint" TEXT,
    "verifyPublicKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "license_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_module_entitlements" (
    "moduleKey" TEXT NOT NULL,
    "entitled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "license_module_entitlements_pkey" PRIMARY KEY ("moduleKey")
);

-- CreateTable
CREATE TABLE "license_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "stateBefore" TEXT,
    "stateAfter" TEXT,
    "message" TEXT NOT NULL,
    "reachable" BOOLEAN,
    "maskedKey" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "license_events_kind_idx" ON "license_events"("kind");

-- CreateIndex
CREATE INDEX "license_events_createdAt_idx" ON "license_events"("createdAt");

