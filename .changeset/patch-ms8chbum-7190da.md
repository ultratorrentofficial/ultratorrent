---
"ultratorrent": patch
---

Storage Profiles: the Default profile toggle now exists. It was in the form payload but had no control, so every profile was created non-default — and a rule set to managed intake without explicitly naming a profile then resolved none and imported nothing, logging only a warning. Profile resolution also falls back to the sole enabled profile when none is flagged, since with one profile there is no ambiguity about which was meant; two or more without a default stays ambiguous and still refuses.
