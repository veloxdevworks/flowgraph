---
"@flowgraph/core": minor
---

`demo` results now say whether the capture actually shows success.

**BREAKING:**

- `ok` is `false` when `http`, `screenshot` or `video` gets an HTTP status of 400 or above. The file is kept as evidence (`path` is set with `ok: false`), a `CAPTURE_FAILED` run issue is raised, and `strict` fails the node. Set `expect: { status: [404] }` when another status is the point.
- `simulator` fails when `simctl` or `adb` reports a failed boot, launch or deep link, when a recorder exits non-zero by itself, or when the output is empty. It used to return `ok: true` with whatever was on screen.
- A `simulator` capture with `app` or `deepLink` now waits for the screen to change and hold still, up to `simulator.settle` (default 30s), because `simctl` and `adb` report a launch as done well before it is drawn. This adds a few seconds at least. If the screen never settles, the capture still happens and raises a warning issue. Recordings now start before the app opens, so they show it opening.
- `file` refuses a source outside the run workspace and this thread's worktrees, including through a symlink, and refuses an empty file.

Fixes:

- `{{ }}` templates now render in `simulator` fields, which also makes simulators usable as agent tools.
- `http.timeout` is honored, and defaults to 30s.
- `http` transcripts and results mask sensitive response headers such as `Set-Cookie`, URL credentials and sensitive query parameters, string fields with sensitive names, and any `{{ secret.* }}` value the node rendered. A `Set-Cookie` header used to be saved in plaintext.
- Gates list failed captures in their message and in a new `captureFailures` field instead of dropping them, and present a capture's `extra` files.
- Preflight checks that Playwright and its browser are ready for `screenshot` and `video`, and that `simctl` really exists rather than only macOS's `xcrun` stub. Missing tools are a preflight error when the capture is `strict`.
- Run issues suggest installing something only when a tool is really missing, and tell a missing Playwright browser apart from a missing package. iOS now points at Xcode, since the command-line tools do not include `simctl`.
- `video` no longer leaves a second copy of each recording in the artifact directory. `strict` failures now reach the manifest.
