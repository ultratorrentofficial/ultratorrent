---
'@ultratorrent/frontend': minor
---

Ship the documentation inside the frontend image. The full manual is now served at
`/docs` by every install — offline, version-matched to the running build, with a
working search index (the index is built at compile time, so it works air-gapped).

The site is also published to GitHub Pages on every push to `main`.
