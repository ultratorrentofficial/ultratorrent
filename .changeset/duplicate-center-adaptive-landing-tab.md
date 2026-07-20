---
"ultratorrent": patch
---

Fix the Duplicate Center opening on an empty screen.

Needs Review is the intended landing tab, but nothing sets `requiresReview` until the recommendation engine lands — so on a live library with **452 duplicate groups** the page opened on a blank tab. That is precisely the "where is everything?" confusion the redesign exists to remove, and it was only visible by driving the deployed page rather than the API.

The opening tab is now derived from the overview: Needs Review when it has something to show, All Open otherwise. Once a group genuinely needs a decision the default moves to it by itself, with no further change, and an explicit click always wins.
