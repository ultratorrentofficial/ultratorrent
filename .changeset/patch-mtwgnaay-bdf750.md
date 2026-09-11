---
"ultratorrent": patch
---

Media Server Analytics: resolve friendly names for Watch History rows imported before connection tracking (no connectionId) too — the majority of a live server's history. The first pass keyed strictly on a non-null connection, leaving that bulk showing raw handles; null-connection rows now share one legacy bucket matched among themselves and never conflated with a real connection.
