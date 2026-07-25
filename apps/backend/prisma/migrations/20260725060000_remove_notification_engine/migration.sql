-- Remove the notification engine entirely, ahead of a rebuild from scratch.
--
-- Both engines go: the legacy Notification Center (channels, rules, recipients,
-- templates, delivery history) and the personal engine layered on top of it.
--
-- THIS DESTROYS CONFIGURATION THAT CANNOT BE REGENERATED FROM THIS REPOSITORY —
-- `notification_channels` held the encrypted SMTP transport and Telegram bot
-- token. Both hosts were dumped to
-- `notification-teardown-backups/{synoplex,qnap}-notifications-v0.46.0.sql`
-- immediately before this ran. Restore from there if the rebuild needs them.
--
-- Dropped in dependency order with CASCADE, because the personal tables carry
-- FKs to `users` and to each other; a plain DROP would fail on the first child.

-- Personal engine (deepest children first).
DROP TABLE IF EXISTS "user_notification_delivery_attempts" CASCADE;
DROP TABLE IF EXISTS "user_notification_deliveries" CASCADE;
DROP TABLE IF EXISTS "user_notification_event_routes" CASCADE;
DROP TABLE IF EXISTS "user_notification_preferences" CASCADE;
DROP TABLE IF EXISTS "user_notification_channels" CASCADE;
DROP TABLE IF EXISTS "user_notification_profiles" CASCADE;
DROP TABLE IF EXISTS "user_notifications" CASCADE;

-- Notification Center.
DROP TABLE IF EXISTS "notification_attachments" CASCADE;
DROP TABLE IF EXISTS "notification_dead_letters" CASCADE;
DROP TABLE IF EXISTS "notification_digests" CASCADE;
DROP TABLE IF EXISTS "notification_queue" CASCADE;
DROP TABLE IF EXISTS "notification_statistics" CASCADE;
DROP TABLE IF EXISTS "notification_events" CASCADE;
DROP TABLE IF EXISTS "notification_deliveries" CASCADE;
DROP TABLE IF EXISTS "notification_routings" CASCADE;
DROP TABLE IF EXISTS "notification_preferences" CASCADE;
DROP TABLE IF EXISTS "notification_rules" CASCADE;
DROP TABLE IF EXISTS "notification_templates" CASCADE;
DROP TABLE IF EXISTS "notification_recipient_members" CASCADE;
DROP TABLE IF EXISTS "notification_recipient_groups" CASCADE;
DROP TABLE IF EXISTS "notification_recipients" CASCADE;
DROP TABLE IF EXISTS "notification_channels" CASCADE;

-- Legacy in-app feed.
DROP TABLE IF EXISTS "notifications" CASCADE;
