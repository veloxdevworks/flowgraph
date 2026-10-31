---
"@flowgraph/server": patch
---

Graph store files and thread meta files are written atomically (a temporary file in the same directory, flushed, renamed over the old file, then the directory flushed), so a request that reads a thread's meta while it is being updated sees the old or the new file, never a partial one that looked like a thread with no stored record. Meta updates for one thread (status patches and re-uploads) apply one at a time, so none is lost.
