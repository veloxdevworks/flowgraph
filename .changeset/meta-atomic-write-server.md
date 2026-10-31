---
"@flowgraph/server": patch
---

Graph store files and thread meta files are written atomically (a temporary file in the same directory, flushed, renamed over the old file, then the directory flushed), so a request that reads a thread's meta while it is being updated sees the old or the new file, never a partial one that looked like a thread with no stored record. Meta updates for one thread (status patches and re-uploads) apply one at a time, so none is lost.

Storing a graph for a thread id whose file already holds another thread id ("a/b" and "a_b" share a file name) is refused with `409 THREAD_ID_CONFLICT` inside the same per-file write queue, so the upload cannot replace the other thread's graph or owner even if the caller's access check raced with another write. Meta writes are queued per file, so thread ids that share a file name are ordered too.
