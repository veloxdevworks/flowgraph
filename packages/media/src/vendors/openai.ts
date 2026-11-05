import type { MediaVendor } from "@flowgraph/core";

/** Placeholder until the adapter is written. */
export const openaiVendor: MediaVendor = {
  vendor: "openai",
  modalities: [],
  create() {
    throw new Error("openai adapter is not implemented yet");
  },
};
