---
"ultratorrent": minor
---

The Media Intake migration wizard. Converting a rule to managed intake is two coordinated edits — repoint its save path at staging and set the mode — and the server refuses half of that pair, so doing it by hand is a two-step dance per rule on an install that may carry hundreds. The wizard previews every rule with its current path, resolved profile, proposed staging path and a verdict, converts a chosen subset in one transaction, and reverts by restoring the save path each rule had before, not just the mode. Nothing is preselected and blocked rules are listed rather than hidden. This is also what media_intake.migrate now guards; it previously protected nothing.
