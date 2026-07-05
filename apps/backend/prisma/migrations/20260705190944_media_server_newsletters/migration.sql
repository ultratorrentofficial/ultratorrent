-- CreateTable
CREATE TABLE "media_server_newsletters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL DEFAULT 'weekly',
    "recipientEmails" JSONB NOT NULL DEFAULT '[]',
    "contentSections" JSONB NOT NULL DEFAULT '[]',
    "subjectTemplate" TEXT,
    "dateRangeMode" TEXT NOT NULL DEFAULT 'since_last_send',
    "lastDays" INTEGER NOT NULL DEFAULT 7,
    "lastSuccessfulSendAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_server_newsletters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_server_newsletter_deliveries" (
    "id" TEXT NOT NULL,
    "newsletterId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subject" TEXT,
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_server_newsletter_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_server_newsletter_deliveries_newsletterId_idx" ON "media_server_newsletter_deliveries"("newsletterId");

-- AddForeignKey
ALTER TABLE "media_server_newsletter_deliveries" ADD CONSTRAINT "media_server_newsletter_deliveries_newsletterId_fkey" FOREIGN KEY ("newsletterId") REFERENCES "media_server_newsletters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
