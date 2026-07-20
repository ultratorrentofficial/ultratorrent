---
"ultratorrent": minor
---

Duplicate Center Phase 3 (part 1) — a deterministic, explainable best-copy recommendation engine, wired into detection.

Every group now stores a judgement instead of the list recomputing one per request: `confidence`, `requiresReview`, `potentialSavingsBytes`, `recommendedItemId`, the ordered per-candidate reasons, and machine-readable warnings. `MediaDuplicateCandidate` rows are populated with each member's rank, score, reasons and a snapshot of its path and size, so a resolution stays auditable after the item row is gone.

**The ranking leads with measured data, because the parsed fields are mostly empty.** `MediaFile` carries two families of technical metadata: parsed from the filename (`resolution`, `videoCodec`, `hdr`) and measured from the container (`width`/`height`, `bitrateKbps`, `durationSec`, `audioChannels`). Measured on a live 29,545-file library: measured fields present on **97.6%**, parsed `resolution` on 18%, `videoCodec` on 8%, and `hdr` on **0%** — the renamer strips exactly those tokens. So ranking is measured height → bitrate → audio channels, with the parsed strings used only as a fallback. There is deliberately **no HDR rule**: the column is empty on every file in the library, and a preference that can never fire is worse than an absent one because it reads as implemented.

**Size is a weak tiebreak, not a policy.** "Largest file wins" is wrong in the ordinary case — a bloated 720p re-encode is not better than a lean 1080p source — so file size only separates candidates that tied on everything measurable. Weights are spaced so a higher tier cannot be outvoted by the sum of lower ones.

**Confidence and review-required are separate, and a group needing review has no auto-keep.** Confidence measures how much evidence separated the winner; `requiresReview` is whether a human must decide anyway. A group is forced to review — with `keepId` null, so no bulk action can sweep it up — on different years, different episodes, different editions (theatrical vs director's cut vs extended vs remastered vs IMAX vs 3D), conflicting provider IDs, a runtime difference beyond 5% (a different cut, not a re-encode), or when nothing was measured at all, because a coin toss dressed as a decision is worse than an abstention.

Ordering is total and ends in an id comparison, so re-running detection never moves the recommendation around. 18 new tests cover the ranking, each review trigger, determinism, and savings arithmetic.
