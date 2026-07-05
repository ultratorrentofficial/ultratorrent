---
"ultratorrent": patch
---

feat(media): add a Stop button to cancel a running IMDb dataset import — cooperative cancellation across both the optimized and full import strategies, marking the run 'cancelled' (already-imported records are kept) with a stop endpoint, WS event, and UI button
