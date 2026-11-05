import type { MediaVendor } from "@flowgraph/core";

/** Placeholder until the adapter is written. */
export const meshyVendor: MediaVendor = {
  vendor: "meshy",
  modalities: [],
  create() {
    throw new Error("meshy adapter is not implemented yet");
  },
};
