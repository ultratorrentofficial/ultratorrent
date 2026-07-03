-- CreateTable
CREATE TABLE "uplm_installed_licenses" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "licensee" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "platform" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uplm_installed_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uplm_license_modules" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "limits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uplm_license_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uplm_license_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "licenseId" TEXT,
    "moduleId" TEXT,
    "message" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'success',
    "metadata" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uplm_license_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uplm_module_export_events" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "catalogHash" TEXT NOT NULL,
    "moduleCount" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "destination" TEXT,
    "result" TEXT NOT NULL DEFAULT 'success',
    "message" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uplm_module_export_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uplm_installed_licenses_licenseId_key" ON "uplm_installed_licenses"("licenseId");

-- CreateIndex
CREATE INDEX "uplm_installed_licenses_active_idx" ON "uplm_installed_licenses"("active");

-- CreateIndex
CREATE INDEX "uplm_license_modules_moduleId_idx" ON "uplm_license_modules"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "uplm_license_modules_licenseId_moduleId_key" ON "uplm_license_modules"("licenseId", "moduleId");

-- CreateIndex
CREATE INDEX "uplm_license_events_eventType_idx" ON "uplm_license_events"("eventType");

-- CreateIndex
CREATE INDEX "uplm_license_events_createdAt_idx" ON "uplm_license_events"("createdAt");

-- CreateIndex
CREATE INDEX "uplm_module_export_events_createdAt_idx" ON "uplm_module_export_events"("createdAt");

-- AddForeignKey
ALTER TABLE "uplm_license_modules" ADD CONSTRAINT "uplm_license_modules_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "uplm_installed_licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
