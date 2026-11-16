---
"@flowgraph/spec": minor
"@flowgraph/core": minor
---

Retry and timeout have one canonical place: set them on the node, with graph defaults in `runtime.retry` and `runtime.timeoutDefault`. `config.defaults.retry`, `config.defaults.timeout`, and HTTP `with.retry` / `with.timeout` are rejected, with an error that names the field to use instead. Other `with.timeout` fields (`shell`, `script`, `wait`, `demo`, media) are unchanged and still enforced as the operation's own deadline.
