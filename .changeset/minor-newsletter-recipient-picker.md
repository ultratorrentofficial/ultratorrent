---
"ultratorrent": minor
---

Newsletter recipients can now be picked from the users synced off your media server, not just typed in. The "add recipients" box keeps free-text entry (type an email, Enter/comma/space to add; recipients show as removable chips) and gains a picker of synced users below it. A user the server gives an email for — Plex accounts, fetched from plex.tv — is one click to add. For servers whose accounts carry no email (Jellyfin/Emby have no email field at all), the user is still listed with an inline field so an admin can enter their address; it's saved back onto the user and reused next time, and never overwritten by a later sync. The user sweep now also pulls each connection's provider account list, so people who have never watched anything still appear. New `MediaServerUser.email` column, a `provider.getUsers` capability (Plex/Jellyfin/Emby; Kodi unsupported), and `GET/PATCH /media-server-analytics/newsletters/recipient-options` (gated on manage_newsletters).
