import type { MediaVendor } from "@flowgraph/core";

/** Placeholder until the adapter is written. */
export const elevenlabsVendor: MediaVendor = {
  vendor: "elevenlabs",
  modalities: [],
  create() {
    throw new Error("elevenlabs adapter is not implemented yet");
  },
};
