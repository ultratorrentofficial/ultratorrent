---
"ultratorrent": patch
---

Fix backend crash-loop on fresh build: break the MediaModule ⇄ AutomationModule DI cycle (ImdbService + MediaProcessingService now resolve AutomationEngine lazily via ModuleRef).
