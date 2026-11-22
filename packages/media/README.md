# @flowgraph/media

> **Preview:** This package is in preview. Its node schemas, `kind: media` provider configuration, and vendor adapter APIs may change before stabilization.

Provides the four generative media node types (`image`, `video`, `model3d`, `audio`), the `kind: media` provider configuration schema, the media job runtime and write-ahead journal, and built-in vendor adapters (xAI, OpenAI, Tripo, Meshy, ElevenLabs).

The Flowgraph CLI and Desktop register this package by default; programmatic hosts can import it directly.

## Usage

```ts
import "@flowgraph/media";
```

Or register explicitly:

```ts
import { registerMediaNodes, registerMediaVendors } from "@flowgraph/media";

registerMediaNodes();
registerMediaVendors();
```
