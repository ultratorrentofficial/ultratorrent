---
'@ultratorrent/frontend': patch
---

Fix three defects in the bundled documentation:

- **Redirects leaked the container's internal port.** nginx builds absolute redirects from
  the port it listens on (8080), so the first visit to `/docs` sent the browser to
  `http://host:8080/docs/` — a port that is not published. `absolute_redirect off` is now
  set at server level, so redirects stay relative to the URL the client actually used.
- **Section URLs with a trailing slash 404'd.** Docusaurus emits both `modules.html` and a
  `modules/` directory, so `/docs/modules/` resolved to the directory — which has no
  `index.html`. Trailing slashes are now stripped before `try_files` runs.
- **Eight Mermaid diagrams rendered as red "Syntax error" boxes**, including one emitted by
  the reference generator. Semicolons inside sequence-diagram messages terminate the
  statement; `[/foo]` is a parallelogram shape, not a label; dotted-link labels containing
  dots need the pipe form; and quoted bare node ids are invalid.

Also adds landing pages for the Learn and Help sections, which previously had no page at
`/docs/learn` or `/docs/help` at all.
