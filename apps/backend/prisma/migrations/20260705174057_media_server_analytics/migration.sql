-- AlterTable
ALTER TABLE "media_server_integrations" ADD COLUMN     "capabilities" JSONB,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastHealthCheckAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "platform" TEXT,
ADD COLUMN     "serverVersion" TEXT,
ADD COLUMN     "status" TEXT;
