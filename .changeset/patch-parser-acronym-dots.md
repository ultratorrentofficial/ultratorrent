---
"ultratorrent": patch
---

Release-name parser: titles that legitimately contain dots are no longer mangled. Because scene releases use dots as word separators, every dot was being turned into a space, which broke names like "L.A.'s Finest" (became "L A 's Finest") and "Chicago P.D." (became "Chicago P D"). Acronyms are now preserved while ordinary scene separators still collapse as before, so shows display with their correct titles.
