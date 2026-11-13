---
"@flowgraph/core": minor
"@flowgraph/server": minor
---

Artifact staging for node placement (ADR-0020 section 10). A placed node's `Artifact` records move by `sha256`: the coordinator uploads only the blobs the worker lacks (streamed, never buffered) and sends staged references (`path: "fg-staged:<sha256>/<basename>"`, `staged: true`) that the worker turns into workspace-relative files when the run starts; records that flow back into the parent are downloaded, hash-verified while streaming, written to `.flowgraph/artifacts/<parentThread>/<nodeId>/` and rewritten (including a `demo` output's legacy absolute paths). Records that name a missing file or one outside the workspace fail the node before dispatch (`ARTIFACT_MISSING`); transfer failures are `ARTIFACT_STAGE_IN_FAILED` / `ARTIFACT_STAGE_OUT_FAILED`.

Core: `WorkerTransport` artifact methods are now `hasArtifact(target, sha256, opts?)`, `putArtifact(target, sha256, file, opts?)` (streams a file) and `getArtifact(target, { threadId, sha256 }, destFile, opts?)` (streams to a file, returns `{ sha256, sizeBytes }`); `ArtifactRef` is replaced by `ArtifactSource`. `createHttpTransport` implements them (`artifactIdleTimeoutMs` aborts a stalled transfer); `createFakeTransport` scripts them through `FakeTransportFixture.artifacts`. `RemoteNodeExecutor` gains `stageOut(ctx, value)`. New exports: `findArtifacts`, `mapArtifacts`, `isArtifactRecord`, `stageIn`, `stageOut`, `StagingError`, `resolveGraphWorkspace`.

Server: `HEAD` / `PUT /worker/artifacts/:sha256` (content store under `.flowgraph/artifact-store`, per-principal on multi-user servers; 400 `ARTIFACT_HASH_MISMATCH`, 413 `ARTIFACT_TOO_LARGE` over `FLOWGRAPH_ARTIFACT_MAX_BYTES`, default 4 GiB), `GET /worker/runs/:threadId/artifacts/:sha256` (owner-checked, workspace-confined), and staged references in `POST /runs` input are materialized before the run starts (422 `ARTIFACT_NOT_STAGED` for an unknown sha). CORS now allows `HEAD` and `PUT`.
