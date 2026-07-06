---
"ultratorrent": patch
---

Move the newsletter Email/SMTP setup out of the Newsletters page onto the Settings page. The EmailSettingsCard (SMTP host/port/secure/auth/from + test-send) is extracted to its own component and rendered on SettingsPage, gated by the media_server_analytics.manage_settings permission; removed from NewslettersPage. Self-contained (keeps its mediaServerAnalytics i18n + API), no behavior change
