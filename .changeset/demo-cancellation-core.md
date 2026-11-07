---
"@flowgraph/core": minor
---

`demo` honors cancellation in every mode (ADR-0019, slice 2). Aborting a run used to leave Playwright and simulator captures running, and a cancelled capture was reported as a failed one.

- `screenshot` and `video` close the browser context on abort, so an in-flight `goto`, `waitFor` or `duration` wait rejects at once, then close the browser. An abort before or during browser launch closes the browser once it starts.
- `simulator` kills the `simctl` and `adb` processes and the settle wait, stops `simctl recordVideo`, and on Android stops `screenrecord` on the device and deletes `/sdcard/flowgraph-demo.*`. Stopping only the adb client left that file behind. A host that exits right after the abort still gets this cleanup.
- `http` and `file` stop too; `file` checks before it copies.
- An abort is a cancellation, not a failed capture: no `CAPTURE_FAILED` issue, no manifest entry, `strict` does not turn it into an error, and the run ends as `aborted`. No half-written file or `.recording-` folder is left in the artifacts folder.
- iOS simulator captures write the settle frames, the screenshot and the recording into a scratch `.recording-` folder inside the artifacts folder, and move only a finished file into place. A cancel removes that folder at once, because the simulator can finish writing a file after `simctl` was killed. A cancel that arrives after the capture finished but before the node returned also discards the files.
