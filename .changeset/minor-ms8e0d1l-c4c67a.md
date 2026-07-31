---
"ultratorrent": minor
---

Missing-episode grabs now follow the show's RSS rule. The rule's savePath is the first source for a grab's directory again — it outranks the library binding, so converting a rule actually changes where its acquisitions land — but only when that directory still exists, so a savePath left behind by a rename falls through to the library instead of recreating a dead folder. When the rule is managed_intake the grab is staged under the storage profile's staging root, and the wanted episode records the torrent hash and the deciding rule so Media Intake recognises the completed download as its own. Without that trace a staged episode would have sat in staging with nothing able to import it.
