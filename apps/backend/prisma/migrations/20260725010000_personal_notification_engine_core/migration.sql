-- Personal Notification Engine — Phase 2 ownership backbone.
--
-- Purely ADDITIVE. The legacy global tables (notification_rules,
-- notification_recipients, notifications, …) are untouched and keep working, so
-- this migration changes no behaviour on its own; the cutover happens in Phase 10.

-- Profile-wide personal settings (quiet hours, digests, pause). Lazily created.
CREATE TABLE "user_notification_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timezone" TEXT,
    "locale" TEXT,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "quietHoursDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "digestDaily" BOOLEAN NOT NULL DEFAULT false,
    "digestDailyAt" TEXT,
    "digestWeekly" BOOLEAN NOT NULL DEFAULT false,
    "digestWeeklyDay" INTEGER,
    "digestWeeklyAt" TEXT,
    "pausedUntil" TIMESTAMP(3),
    "onboardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_notification_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notification_profiles_userId_key" ON "user_notification_profiles"("userId");

-- A personal delivery connection. Several of the same type per user is the point.
CREATE TABLE "user_notification_channels" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- email | telegram | whatsapp | discord  (sms retired; in-app needs no row)
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "lastTestedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    -- AES-GCM (SecretCipher). Never returned by the API.
    "encryptedConfig" JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "destinationMask" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    -- Soft delete: delivery history must outlive the connection it used.
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "user_notification_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_notification_channels_userId_type_enabled_idx" ON "user_notification_channels"("userId", "type", "enabled");

-- Override rows only (lazy defaults). NULL column = inherit from the catalogue.
CREATE TABLE "user_notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "deliveryMode" TEXT,
    "quietHoursBehavior" TEXT,
    "minSeverity" TEXT,
    "dedupeWindowSec" INTEGER,
    "aggregationWindowMin" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notification_preferences_userId_eventKey_key" ON "user_notification_preferences"("userId", "eventKey");
CREATE INDEX "user_notification_preferences_userId_idx" ON "user_notification_preferences"("userId");

-- One selected destination for one event. Normalized so one event can fan out to
-- several connections of the same type.
CREATE TABLE "user_notification_event_routes" (
    "id" TEXT NOT NULL,
    "preferenceId" TEXT NOT NULL,
    -- in_app | email | telegram | whatsapp | discord
    "channelType" TEXT NOT NULL,
    -- NULL for in_app; otherwise a connection owned by the SAME user (enforced in
    -- the service layer — the DB cannot express the two-hop ownership check).
    "channelConnectionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deliveryMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_notification_event_routes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notification_event_routes_pref_type_conn_key" ON "user_notification_event_routes"("preferenceId", "channelType", "channelConnectionId");
CREATE INDEX "user_notification_event_routes_preferenceId_channelType_idx" ON "user_notification_event_routes"("preferenceId", "channelType");
CREATE INDEX "user_notification_event_routes_channelConnectionId_idx" ON "user_notification_event_routes"("channelConnectionId");

-- Personal in-app notification: exactly one eligible owner (the property the
-- legacy `notifications` table could not hold — its userId was nullable).
CREATE TABLE "user_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "deepLink" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "groupCount" INTEGER NOT NULL DEFAULT 1,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notifications_userId_dedupeKey_key" ON "user_notifications"("userId", "dedupeKey");
CREATE INDEX "user_notifications_userId_readAt_idx" ON "user_notifications"("userId", "readAt");
CREATE INDEX "user_notifications_userId_createdAt_idx" ON "user_notifications"("userId", "createdAt");
CREATE INDEX "user_notifications_userId_archivedAt_idx" ON "user_notifications"("userId", "archivedAt");

-- Ownership is a hard invariant: every row cascades from its owning user.
ALTER TABLE "user_notification_profiles" ADD CONSTRAINT "user_notification_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_channels" ADD CONSTRAINT "user_notification_channels_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_event_routes" ADD CONSTRAINT "user_notification_event_routes_preferenceId_fkey"
    FOREIGN KEY ("preferenceId") REFERENCES "user_notification_preferences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
