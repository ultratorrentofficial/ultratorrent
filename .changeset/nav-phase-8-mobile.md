---
'@ultratorrent/frontend': minor
---

nav(Phase 8): mobile redesign. A bottom domain switcher (`MobileDomainBar`,
`lg:hidden`) puts every domain one tap away via its landing hub, with a trailing
"Menu" button for the full drawer. The mobile nav drawer is now swipe-to-dismiss
(`useSwipeToDismiss` — a horizontal-swipe gesture that ignores vertical scrolls).
Content gains bottom padding so the fixed bar never covers it. Desktop is
unchanged.
