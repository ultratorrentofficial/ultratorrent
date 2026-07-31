---
"ultratorrent": patch
---

Storage Profiles: the staging root is now chosen with the file browser instead of typed, and a missing directory is offered for creation before the profile saves. The field takes a path in the BACKEND's filesystem (/downloads/... in the stock Docker deployment), not the host's — browsing is rooted at FILE_MANAGER_ROOTS so it can only produce the correct form.
