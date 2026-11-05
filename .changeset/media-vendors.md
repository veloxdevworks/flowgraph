---
"@flowgraph/media": minor
"@flowgraph/cli": patch
"@flowgraph/server": patch
---

New `@flowgraph/media` package: reference media vendors for the `image`, `video`, `model3d` and `audio` nodes (xAI, OpenAI, Tripo, Meshy, ElevenLabs). The CLI and server load it so graphs can name these vendors in `providers:`.
