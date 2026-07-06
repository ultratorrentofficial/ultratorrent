-- CreateTable
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "rateLimitPerMin" INTEGER,
    "retryPolicy" JSONB NOT NULL DEFAULT '{}',
    "quietHours" JSONB NOT NULL DEFAULT '{}',
    "allowedEvents" JSONB NOT NULL DEFAULT '[]',
    "allowedGroupIds" JSONB NOT NULL DEFAULT '[]',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipients" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "telegramChatId" TEXT,
    "whatsappNumber" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT,
    "preferredChannelId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHours" JSONB NOT NULL DEFAULT '{}',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipient_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_recipient_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipient_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_recipient_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "event" TEXT,
    "subject" TEXT,
    "title" TEXT,
    "subtitle" TEXT,
    "html" TEXT,
    "text" TEXT,
    "markdown" TEXT,
    "sms" TEXT,
    "whatsapp" TEXT,
    "telegram" TEXT,
    "card" JSONB NOT NULL DEFAULT '{}',
    "variables" JSONB NOT NULL DEFAULT '[]',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "event" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "recipients" JSONB NOT NULL DEFAULT '{}',
    "channelIds" JSONB NOT NULL DEFAULT '[]',
    "templateId" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "quietHoursOverride" BOOLEAN NOT NULL DEFAULT false,
    "dedupeWindowSec" INTEGER NOT NULL DEFAULT 0,
    "retryPolicy" JSONB NOT NULL DEFAULT '{}',
    "escalationPolicy" JSONB NOT NULL DEFAULT '{}',
    "rateLimitPerHour" INTEGER,
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "eventId" TEXT,
    "event" TEXT NOT NULL,
    "channelId" TEXT,
    "provider" TEXT NOT NULL,
    "recipientId" TEXT,
    "destination" TEXT,
    "templateId" TEXT,
    "subject" TEXT,
    "renderedBody" TEXT,
    "card" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "dedupeKey" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_queue" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attachments" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT,
    "templateId" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "url" TEXT,
    "artworkId" TEXT,
    "cid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT,
    "matchedRules" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_statistics" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "provider" TEXT,
    "channelId" TEXT,
    "event" TEXT,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_channels_provider_idx" ON "notification_channels"("provider");

-- CreateIndex
CREATE INDEX "notification_channels_enabled_idx" ON "notification_channels"("enabled");

-- CreateIndex
CREATE INDEX "notification_recipients_userId_idx" ON "notification_recipients"("userId");

-- CreateIndex
CREATE INDEX "notification_recipients_email_idx" ON "notification_recipients"("email");

-- CreateIndex
CREATE UNIQUE INDEX "notification_recipient_groups_name_key" ON "notification_recipient_groups"("name");

-- CreateIndex
CREATE INDEX "notification_recipient_members_recipientId_idx" ON "notification_recipient_members"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_recipient_members_groupId_recipientId_key" ON "notification_recipient_members"("groupId", "recipientId");

-- CreateIndex
CREATE INDEX "notification_templates_event_idx" ON "notification_templates"("event");

-- CreateIndex
CREATE INDEX "notification_rules_event_idx" ON "notification_rules"("event");

-- CreateIndex
CREATE INDEX "notification_rules_enabled_idx" ON "notification_rules"("enabled");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries"("status");

-- CreateIndex
CREATE INDEX "notification_deliveries_channelId_idx" ON "notification_deliveries"("channelId");

-- CreateIndex
CREATE INDEX "notification_deliveries_recipientId_idx" ON "notification_deliveries"("recipientId");

-- CreateIndex
CREATE INDEX "notification_deliveries_ruleId_idx" ON "notification_deliveries"("ruleId");

-- CreateIndex
CREATE INDEX "notification_deliveries_event_idx" ON "notification_deliveries"("event");

-- CreateIndex
CREATE INDEX "notification_deliveries_priority_idx" ON "notification_deliveries"("priority");

-- CreateIndex
CREATE INDEX "notification_deliveries_createdAt_idx" ON "notification_deliveries"("createdAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_dedupeKey_idx" ON "notification_deliveries"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_preferences_recipientId_idx" ON "notification_preferences"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_recipientId_event_channel_key" ON "notification_preferences"("recipientId", "event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_queue_deliveryId_key" ON "notification_queue"("deliveryId");

-- CreateIndex
CREATE INDEX "notification_queue_scheduledFor_idx" ON "notification_queue"("scheduledFor");

-- CreateIndex
CREATE INDEX "notification_queue_priority_idx" ON "notification_queue"("priority");

-- CreateIndex
CREATE INDEX "notification_attachments_deliveryId_idx" ON "notification_attachments"("deliveryId");

-- CreateIndex
CREATE INDEX "notification_events_event_idx" ON "notification_events"("event");

-- CreateIndex
CREATE INDEX "notification_events_createdAt_idx" ON "notification_events"("createdAt");

-- CreateIndex
CREATE INDEX "notification_events_dedupeKey_idx" ON "notification_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_statistics_date_idx" ON "notification_statistics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "notification_statistics_date_provider_channelId_event_key" ON "notification_statistics"("date", "provider", "channelId", "event");
