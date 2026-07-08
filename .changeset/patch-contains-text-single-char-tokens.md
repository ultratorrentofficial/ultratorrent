---
"ultratorrent": patch
---

RSS match engine: extend `contains_text` whole-token matching to single-character words (previously only numeric). A separator-heavy short title like "M.I.A" normalizes to "m","i","a", which as substrings appear in almost every release ("megusta" alone supplies "m" and "a") — the same over-match class as "9-1-1". Single-letter pattern words now require a standalone title token; also does the right thing for acronym titles (S.W.A.T, M.A.S.H).
