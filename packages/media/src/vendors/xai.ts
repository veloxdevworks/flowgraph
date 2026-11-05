import type { MediaVendor } from "@flowgraph/core";

/** Placeholder until the adapter is written. */
export const xaiVendor: MediaVendor = {
  vendor: "xai",
  modalities: [],
  create() {
    throw new Error("xai adapter is not implemented yet");
  },
};
