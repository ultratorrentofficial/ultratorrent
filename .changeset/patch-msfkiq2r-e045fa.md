---
"ultratorrent": patch
---

A rename now deletes the junk left beside the film and removes the emptied release folder. Cleanup patterns previously only applied to files in the rename batch, so a rename started from the Library Browser — which passes just the video — left the release folder standing with its YTS.txt and site.jpg inside, and reported deleting nothing.
