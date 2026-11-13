# Media (mock vendor) example

Shows the **generative media** path end to end with no network or API keys:

- `mock-vendor.ts` is a **media vendor plugin**, the template for adding a real
  one (Tripo, Meshy, a local tool, ...). It registers a vendor with
  `registerMediaVendor` and implements `start` / `poll` / `fetch`.
- `media.graph.yaml` loads it with `imports[].providers`, declares
  `providers: { art: { kind: media, vendor: mock-media } }`, and chains an
  `image` node into a `model3d` node (image-to-3D) by passing the first node's
  `Artifact`.

```bash
pnpm install
pnpm test
pnpm start      # artifacts land under .flowgraph/artifacts/<thread>/<node>/
```

To use real backends, change only the `providers:` block. For example,
`{ kind: langchain, vendor: xai }` serves both agents and images from one
entry. See [03 §9d](../../docs/03-node-types.md) and
[08 — Media providers](../../docs/08-providers.md).
