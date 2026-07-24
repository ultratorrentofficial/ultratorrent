---
"ultratorrent": patch
---

Fix the duplicate-group table blowing past the viewport when a file path is very long. The Item cell shows the path in a truncate element, but the table used the browser default auto layout, in which a cell grows to its content's intrinsic width before overflow:hidden can clip — so a long unrenamed release path (e.g. The.Lincoln.Lawyer.S02.COMPLETE.720p.NF.WEBRip.x264[eztv.re] nested twice) expanded the column and broke the page layout. The list table is now table-fixed with the four short columns (Year, S/E, Resolution, Size) pinned to fixed widths and marked whitespace-nowrap, so the Item column takes the remaining width and its title/path truncate within it as intended.
