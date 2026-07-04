---
"ultratorrent": minor
---

Add an in-app update check. The About dialog now shows whether a newer UltraTorrent release is available (compared against the GitHub release tags), with a Check now button, release-notes link, and the exact deployment-specific commands to apply it. New endpoints: GET /api/system/update (status), POST /api/system/update/check (force check, system.view), PATCH /api/system/update/settings (toggle, system.manage). SystemUpdateService detects Docker vs bare-metal (/.dockerenv + cgroups, overridable via ULTRATORRENT_DEPLOYMENT) and runs a daily background check (on by default, toggleable) plus on demand. Note: the app never auto-applies updates — in Docker a container can't replace its own image, and updates rebuild from source — so it surfaces the right command instead (docker compose up -d --build vs git pull + build + restart).
