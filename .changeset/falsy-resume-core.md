---
"@flowgraph/core": patch
---

- `compiled.resume()` and `resumeFrom()` with a falsy answer (`false`, `null`, `0`, `""`) now resume the pending interrupts with that value, so a denied approval from outside the run records `approved: false`. This covers the CLI's `flowgraph resume --resume false`, the server's resume endpoints and a webhook POST with a falsy JSON body. Previously each failed with `Received empty Command input`. A missing answer (`resume` left out or `undefined`) is not a denial: while an interrupt is pending, `resume()` rejects with `error.code` `RESUME_VALUE_REQUIRED` and runs nothing.
- A `hitl` choice now accepts a number as its 1-based index (`2` picks the second choice), bare or as `{ choice: 2 }`. A number is always an index, even when the choices are numeric strings; a string still matches a choice before it is read as an index. Previously a number was read as an empty answer, so `1` or `2` was rejected as `Invalid choice ""` on every attempt, including after an invalid answer.
