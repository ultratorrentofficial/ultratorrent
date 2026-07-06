---
"ultratorrent": minor
---

Media Items page performance: paginate GET /media/items instead of loading every item at once (28k+ item libraries made the page take many seconds). Server-side page/pageSize (default 60) + total + case-insensitive title search; frontend gains a search box and prev/next pager on both the Media Items and Unmatched pages. ~170x faster DB fetch and a bounded payload/render
