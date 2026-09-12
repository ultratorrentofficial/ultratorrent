-- Household & Sharing (advisory account-sharing detection). Additive, non-destructive.
-- Applied with `prisma migrate deploy`; no existing table is modified.

CREATE TABLE "media_household_profiles" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "displayName" TEXT,
    "homeNetworkId" TEXT,
    "homeConfidence" INTEGER NOT NULL DEFAULT 0,
    "homeLocked" BOOLEAN NOT NULL DEFAULT false,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'none',
    "reasons" JSONB,
    "firstObservedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_household_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_household_profiles_subjectKey_key" ON "media_household_profiles" ("subjectKey");

CREATE TABLE "media_household_networks" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "representativeIp" TEXT,
    "asn" INTEGER,
    "isp" TEXT,
    "countryCode" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "networkType" TEXT NOT NULL DEFAULT 'unknown',
    "classificationSource" TEXT NOT NULL DEFAULT 'auto',
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "watchSeconds" INTEGER NOT NULL DEFAULT 0,
    "distinctDays" INTEGER NOT NULL DEFAULT 0,
    "uniqueDevices" INTEGER NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "disposition" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_household_networks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_household_networks_profileId_fingerprint_key" ON "media_household_networks" ("profileId", "fingerprint");
CREATE INDEX "media_household_networks_profileId_idx" ON "media_household_networks" ("profileId");
CREATE INDEX "media_household_networks_fingerprint_idx" ON "media_household_networks" ("fingerprint");
ALTER TABLE "media_household_networks"
    ADD CONSTRAINT "media_household_networks_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "media_household_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "media_sharing_signals" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'moderate',
    "scoreDelta" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstOccurred" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOccurred" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_sharing_signals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_sharing_signals_profileId_signalType_key" ON "media_sharing_signals" ("profileId", "signalType");
CREATE INDEX "media_sharing_signals_profileId_idx" ON "media_sharing_signals" ("profileId");
ALTER TABLE "media_sharing_signals"
    ADD CONSTRAINT "media_sharing_signals_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "media_household_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "media_sharing_reviews" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'none',
    "reasons" JSONB,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_sharing_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_sharing_reviews_profileId_idx" ON "media_sharing_reviews" ("profileId");
CREATE INDEX "media_sharing_reviews_status_idx" ON "media_sharing_reviews" ("status");
ALTER TABLE "media_sharing_reviews"
    ADD CONSTRAINT "media_sharing_reviews_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "media_household_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
