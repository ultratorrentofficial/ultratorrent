---
"ultratorrent": patch
---

Media artwork: stop posters falling back to the stub icon, and fetch missing art from providers on scan. (1) The frontend artworkImage() blob fetch bypassed request()'s auth handling and never refreshed on 401, so once the 15-minute access token expired every local poster silently 401'd and showed the placeholder until a full reload — it now refreshes + retries once like every other call. (2) Library scans now ALWAYS import local folder artwork (poster/fanart/folder sidecars), no longer gated behind the artwork-fetch flag, and fall back to a provider fetch for items whose folder has no poster (self-limiting: no network without a configured key + metadata id).
