-- =========================================================================
-- REMOVED — historical record. Every table this script queries was dropped on
-- 2026-07-25 (v0.47.0) when the notification engine was torn out for a rebuild.
-- Running this now fails with "relation does not exist". Kept for the queries
-- themselves, which encode what a correct migration had to prove.
-- =========================================================================

-- Personal Notification Engine — migration validation.
--
-- Every query below MUST return zero rows. Each one asserts an invariant the
-- engine's design depends on; a non-zero result is a migration defect, not a
-- warning. Run against a host before and after the Phase 10 cutover:
--
--   docker exec -i <postgres> psql -U ultratorrent -d ultratorrent \
--     -f - < ops/scripts/notification-engine-validate.sql
--
-- Read the `violation` column: it names what went wrong, not just that something did.

\echo '=== 1. No external identity owns a notification profile ==='
-- A MediaServerUser (Plex/Jellyfin/Emby viewer) cannot authenticate, so it must
-- never own anything. Ids live in different tables; this catches a profile whose
-- owner is absent from `users` entirely.
SELECT 'profile with no local user' AS violation, p."userId"
FROM user_notification_profiles p
LEFT JOIN users u ON u.id = p."userId"
WHERE u.id IS NULL;

\echo '=== 2. Every connection has exactly one eligible owner ==='
SELECT 'connection with no local user' AS violation, c.id, c."userId"
FROM user_notification_channels c
LEFT JOIN users u ON u.id = c."userId"
WHERE u.id IS NULL;

\echo '=== 3. Every in-app notification has one eligible owner ==='
SELECT 'notification with no local user' AS violation, n.id, n."userId"
FROM user_notifications n
LEFT JOIN users u ON u.id = n."userId"
WHERE u.id IS NULL;

\echo '=== 4. Every route references a connection owned by the SAME user ==='
-- The cross-user boundary. The database cannot express this constraint (it spans
-- preference -> user and connection -> user), so it is enforced in the service
-- layer and verified here.
SELECT 'route points at another user''s connection' AS violation,
       r.id AS route_id, p."userId" AS preference_owner, c."userId" AS connection_owner
FROM user_notification_event_routes r
JOIN user_notification_preferences p ON p.id = r."preferenceId"
JOIN user_notification_channels c ON c.id = r."channelConnectionId"
WHERE r."channelConnectionId" IS NOT NULL
  AND c."userId" <> p."userId";

\echo '=== 5. Only the in-app route may omit a connection ==='
SELECT 'external route with no connection' AS violation, r.id, r."channelType"
FROM user_notification_event_routes r
WHERE r."channelType" <> 'in_app'
  AND r."channelConnectionId" IS NULL;

\echo '=== 6. The in-app route never carries a connection ==='
SELECT 'in-app route with a connection' AS violation, r.id
FROM user_notification_event_routes r
WHERE r."channelType" = 'in_app'
  AND r."channelConnectionId" IS NOT NULL;

\echo '=== 7. No delivery targets a connection its recipient does not own ==='
SELECT 'delivery through another user''s connection' AS violation,
       d.id, d."userId" AS delivery_owner, c."userId" AS connection_owner
FROM user_notification_deliveries d
JOIN user_notification_channels c ON c.id = d."channelId"
WHERE d."channelId" IS NOT NULL
  AND c."userId" <> d."userId";

\echo '=== 8. No retired channel type is in use ==='
-- `sms` was retired as a personal channel; Slack and generic webhooks are
-- integration messages, never personal notifications.
SELECT 'retired channel type in use' AS violation, c.id, c.type
FROM user_notification_channels c
WHERE c.type NOT IN ('email', 'telegram', 'whatsapp', 'discord');

SELECT 'retired channel type in a route' AS violation, r.id, r."channelType"
FROM user_notification_event_routes r
WHERE r."channelType" NOT IN ('in_app', 'email', 'telegram', 'whatsapp', 'discord');

\echo '=== 9. No ACTIVE global event-to-destination routing remains ==='
-- The legacy rule set may still exist during the transition, but once cut over no
-- ENABLED rule may pin channels: that is the global routing this engine removed.
SELECT 'enabled legacy rule still pinning channels' AS violation, id, name, event
FROM notification_rules
WHERE enabled = true
  AND "channelIds"::text NOT IN ('[]', 'null');

\echo '=== 10. The global personal-channel credential blob is gone ==='
-- One shared Telegram/Discord/webhook credential for the whole install cannot
-- express personal ownership at all.
SELECT 'global channel blob still present' AS violation, key
FROM settings
WHERE key = 'notifications.channels';

\echo '=== 11. No legacy unowned in-app notification remains un-archived ==='
-- These were broadcasts: `userId` was nullable and, on a live install, null for
-- every row. Ownership cannot be inferred, so they are archived, never adopted.
SELECT 'unowned legacy notification' AS violation, count(*) AS rows
FROM notifications
WHERE "userId" IS NULL
HAVING count(*) > 0;

\echo '=== 12. Every stored preference names a registered event ==='
-- Catches a preference orphaned by an event being removed from the catalogue.
-- The expected list is maintained in code; this reports distinct keys for review
-- rather than hard-coding 69 of them here.
SELECT DISTINCT 'preference for possibly-unregistered event' AS note, "eventKey"
FROM user_notification_preferences
ORDER BY 2;

\echo '=== Validation complete. Queries 1-11 must return zero rows. ==='
