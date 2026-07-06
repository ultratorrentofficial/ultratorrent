---
"ultratorrent": patch
---

Equal-height newsletter card grid (Gmail-safe). Two cards in a row rendered at their own content heights, so a show with a long overview left its paired card's panel visibly shorter/ragged. The card panel (background/border/padding) now lives on the grid cell instead of a nested table — sibling cells in a table row are always drawn at equal height, which Gmail/Outlook honour (unlike height:100% on a nested table, which only browsers respect). A shared twoColGrid() lays out panel-cell / gutter-cell / panel-cell rows; on mobile the columns collapse to full width (panel padding preserved) and the gutter is hidden.
