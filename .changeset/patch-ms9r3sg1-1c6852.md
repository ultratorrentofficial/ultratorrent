---
"ultratorrent": patch
---

Importing a large RSS rules bundle failed with 'Internal server error'. Two causes: no JSON body limit was configured, so Express's 100 KB default applied and a bundle exported from a populated install exceeded it; and body-parser's PayloadTooLargeError is not a Nest HttpException, so the filter flattened it to a generic 500 that told the operator nothing. The limit is now 25 MB, an error that declares its own 4xx is reported honestly (413 with 'the uploaded file is too large', 400 for malformed JSON), and unknown errors are still hidden behind a generic 500. Export can also be scoped to specific rules now, not just a whole install or one feed.
