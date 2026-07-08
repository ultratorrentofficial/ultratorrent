---
"ultratorrent": patch
---

Media identification: make the library's declared kind authoritative for movie-vs-TV classification, and strip a parenthesized `(Year)` from episode titles. Fixes shows like "9-1-1 (2018)" scanning as a movie (and titled "9-1-1 2018") while their episodes still grouped into seasons.
