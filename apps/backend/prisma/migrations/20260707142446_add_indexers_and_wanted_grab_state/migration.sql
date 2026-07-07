-- AlterTable
ALTER TABLE "wanted_episodes" ADD COLUMN     "downloadUrl" TEXT,
ADD COLUMN     "grabbedAt" TIMESTAMP(3),
ADD COLUMN     "grabbedEvaluationId" TEXT,
ADD COLUMN     "lastSearchedAt" TIMESTAMP(3),
ADD COLUMN     "releaseTitle" TEXT,
ADD COLUMN     "searchStatus" TEXT NOT NULL DEFAULT 'idle';

-- AlterTable
ALTER TABLE "wanted_movies" ADD COLUMN     "downloadUrl" TEXT,
ADD COLUMN     "grabbedAt" TIMESTAMP(3),
ADD COLUMN     "grabbedEvaluationId" TEXT,
ADD COLUMN     "lastSearchedAt" TIMESTAMP(3),
ADD COLUMN     "releaseTitle" TEXT,
ADD COLUMN     "searchStatus" TEXT NOT NULL DEFAULT 'idle';

-- CreateTable
CREATE TABLE "indexers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "implementation" TEXT NOT NULL DEFAULT 'torznab',
    "protocol" TEXT NOT NULL DEFAULT 'torrent',
    "baseUrl" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 25,
    "categories" INTEGER[] DEFAULT ARRAY[5000, 5030, 5040]::INTEGER[],
    "capabilities" JSONB,
    "minSeeders" INTEGER,
    "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "statusMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indexers_enabled_idx" ON "indexers"("enabled");
