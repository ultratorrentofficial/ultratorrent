# Issue labels

The issue forms in [`ISSUE_TEMPLATE/`](ISSUE_TEMPLATE/) apply a label automatically so
that a new issue lands already triaged by kind. GitHub applies a label only if it
already exists on the repository — a form referencing a missing label is **not** an
error, the label is simply dropped and the issue arrives unlabelled.

Labels cannot be created from the form YAML, so the four below have to be created once,
by a maintainer, in **Issues → Labels**.

## Already present

| Label | Used by |
| --- | --- |
| `bug` | `bug_report.yml` |
| `enhancement` | `feature_request.yml` |
| `documentation` | `documentation.yml` |

## To be created

| Label | Used by | Suggested description | Suggested colour |
| --- | --- | --- | --- |
| `installation` | `installation.yml` | Installing, deploying, upgrading or starting UltraTorrent | `#0e8a16` |
| `integration` | `integration.yml` | Torrent engines, indexers, metadata providers, media servers | `#1d76db` |
| `ui` | `ui_ux.yml` | Interface, usability, layout and accessibility | `#c5def5` |
| `performance` | `performance.yml` | CPU, memory, latency, database and large-library scale | `#fbca04` |

Until they exist, those four forms still work — issues simply arrive without the kind
label, and can be labelled by hand.

The remaining default labels (`duplicate`, `good first issue`, `help wanted`, `invalid`,
`question`, `wontfix`) are applied during triage rather than by a form.
