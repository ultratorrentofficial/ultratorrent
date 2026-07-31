---
"ultratorrent": patch
---

A rule cannot be set to managed intake while it still downloads into one of its destination libraries. Managed intake places files into the library from wherever the torrent landed, so if the torrent already landed there the placement is library-to-library and the library gains the raw release filename alongside the renamed hardlink — a duplicate of every episode it imports. The pair was trivially reachable, because importMode and savePath are independent fields and every rule predating Media Intake points at a library, which is what legacy direct import means. It refuses rather than repointing, since rewriting where downloads go should not be a side effect of a checkbox, and the message names the profile's staging root so the fix is one paste away.
