---
'@ultratorrent/frontend': minor
---

nav(Workspace Phase 4): command palette — fuzzy matching, scoped search, more
providers. Pages and actions are ranked by a lightweight subsequence fuzzy
matcher (`lib/fuzzy.ts`; fuzzy on the label, substring on aux fields). Inside a
workspace, Tab (or the scope chip) limits results to that workspace (pages by
group, actions/entities by a new `scope` tag; Backspace/Esc lift it). New gated
entity providers: RSS rules, Users, and Jobs (each opening a real target).
