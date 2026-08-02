---
"ultratorrent": patch
---

Four more screens stop showing users JSON. The Decision Simulator dumped each stage's detail as pretty-printed JSON in a <pre>; Settings rendered any object-valued setting through JSON.stringify; File properties showed a file's media info as a quoted blob; and Media Acquisition fell back to JSON for any metadata value that was not a scalar. All now render as readable text — keys as words, values by meaning, unset fields omitted. Two deliberate exceptions: the RSS rule bundle is a FILE DOWNLOAD, where JSON is the interchange format rather than something shown in the UI; and the workflow Node Config panel is an editor whose input is a JSON value, so replacing it needs a typed per-node editor rather than a formatter — the same shape of work the policy builder was, and not something to fake with a display component.
