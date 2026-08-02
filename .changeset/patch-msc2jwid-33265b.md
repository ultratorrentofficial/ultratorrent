---
"ultratorrent": patch
---

An untitled episode is no longer named after IMDb's placeholder. IMDb stores `Episode #3.1` as an ordinary string when it has no title for an episode — 2.8 million of them in the dataset — and the renamer's check for "is there a title" was truthiness, which accepts it. So the placeholder beat providers that knew the real name: the first episode imported through Media Intake landed as `Lioness - S03E01 - Episode #3.1.mkv` while TMDB already had "The Spider and the Fly". Recent episodes hit this as the common case rather than an edge, because IMDb titles them late. The IMDb-supplied title is now rejected when it matches that placeholder shape (including the shorter `Episode #1` and bare `Episode #` forms), so it falls through to the provider chain exactly as an absent title always did. A show that genuinely titles episodes "Episode 1" is unaffected — the `#` is required.
