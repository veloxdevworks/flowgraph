/**
 * Reference media vendors for flowgraph. Importing this package registers them
 * with @flowgraph/core, so `providers:` entries naming these vendors resolve:
 *
 *   providers:
 *     grok:   { kind: langchain, vendor: xai }       # also serves image/video
 *     gpt:    { kind: langchain, vendor: openai }    # also serves images
 *     tripo:  { kind: media, vendor: tripo }
 *     meshy:  { kind: media, vendor: meshy }
 *     voices: { kind: media, vendor: elevenlabs }
 */

import { registerMediaVendor, type MediaVendor } from "@flowgraph/core";
import { elevenlabsVendor } from "./vendors/elevenlabs.js";
import { meshyVendor } from "./vendors/meshy.js";
import { openaiVendor } from "./vendors/openai.js";
import { tripoVendor } from "./vendors/tripo.js";
import { xaiVendor } from "./vendors/xai.js";

export const MEDIA_VENDORS: readonly MediaVendor[] = [xaiVendor, openaiVendor, tripoVendor, meshyVendor, elevenlabsVendor];

/** Register every vendor above (idempotent). Runs on import. */
export function registerMediaVendors(): void {
  for (const v of MEDIA_VENDORS) registerMediaVendor(v);
}
registerMediaVendors();

export { xaiVendor, openaiVendor, tripoVendor, meshyVendor, elevenlabsVendor };
export { VendorHttpError, resolveApiKey, requestJson, joinUrl, base64ToBytes } from "./http.js";
