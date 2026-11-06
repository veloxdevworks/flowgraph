---
"@flowgraph/core": minor
---

The optional `playwright` peer now needs `^1.55.1`. Earlier versions download browsers without verifying TLS (GHSA-7mvr-c777-76hp). Playwright 1.64 records `demo` video as VP9 rather than VP8, still in `.webm`.
