---
"ultratorrent": patch
---

Media identification: for episodic files in a `Show/Season NN/episode` layout, take the series title from the show folder instead of the filename (which often carries only the episode title). Fixes shows like "9-1-1 (2018)" fragmenting into one series per episode. A loose scene release not inside a season container keeps its filename title.
