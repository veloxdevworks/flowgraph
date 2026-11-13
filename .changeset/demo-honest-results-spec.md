---
"@flowgraph/spec": minor
---

`demo` `http`, `screenshot` and `video` accept `expect: { status: number[] }`, the statuses that count as success (default: any status below 400). `simulator` accepts `settle`, the longest wait for the screen after a launch or deep link. Clearer descriptions for `http.timeout`, `video.waitFor`, `video.duration` and `simulator.device`.
