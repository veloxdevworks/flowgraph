---
"@flowgraph/server": patch
---

Creating a thread's meta file in the graph store is exclusive across processes. Two servers sharing one store could both find no meta file for a new thread and both write one, so the second silently replaced the first thread's graph and owner. The meta file is now written and flushed to a temporary file and hard-linked into place, which fails if the file exists. That makes the create exclusive, and the file is never seen half-written. The losing request gets `409 THREAD_ID_CONFLICT` and changes neither file. The graph YAML is staged before the meta file is created and moved into place only after it, so the loser never overwrites the winner's graph. On filesystems without hard links, the file is created with an exclusive open instead. If moving the graph into place fails after the meta file was created, the meta file stays. That keeps the thread claimed by the requesting owner, whose next upload stores the graph.

`updateGraphMeta` refuses with `409 THREAD_ID_CONFLICT` to patch a meta file that belongs to another thread id sharing its file name (`a/b` and `a_b`), instead of writing into that thread's record.

A thread id that is empty or longer than 234 characters (`MAX_THREAD_ID_LENGTH`, now exported) is refused with `400 INVALID_THREAD_ID`. A 300-character id used to fail with a file-name-too-long error that came back as `503 THREAD_META_UNREADABLE`. Listing stored threads skips a meta file whose name holds no valid thread id, such as `.graph.yaml.meta.json` from an empty id, and logs it instead of listing it.
