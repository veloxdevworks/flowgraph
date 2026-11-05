import type { MediaVendor } from "@flowgraph/core";

/** Placeholder until the adapter is written. */
export const tripoVendor: MediaVendor = {
  vendor: "tripo",
  modalities: [],
  create() {
    throw new Error("tripo adapter is not implemented yet");
  },
};
