---
"ultratorrent": patch
---

**Bundled documentation: every section landing page was unreachable.** Docusaurus emits both a `develop.html` page and a `develop/` directory (holding that section's leaf pages), and nginx's `try_files $uri $uri/ $uri.html` matched the *directory* first — so `/docs/develop` 301'd to `/docs/develop/`, which has no `index.html`, and returned **403**. Only deep links like `/docs/help/faq` worked. Trying `$uri.html` first fixes it. Two related fixes in the same block: the 301 no longer leaks the container's internal `:8080` into an absolute redirect (which sent browsers to a port that isn't published), and a category folder with no landing page now serves the docs site's own 404 page instead of a bare 403.
