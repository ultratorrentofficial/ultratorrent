---
"ultratorrent": patch
---

RSS history match-test now scans the newest 5000 feed-history rows instead of 200, so on busy feeds a rule's real matches (many release variants per episode push past 200 rows) are found instead of wrongly reporting no matches
