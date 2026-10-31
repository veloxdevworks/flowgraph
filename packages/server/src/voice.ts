import { mintEphemeralToken, apiKeyEnvForVoice, voiceProvider } from "@flowgraph/workshop-session";
import { errorFields, log } from "./metrics.js";
import type { ServerConfig } from "./types.js";
import { authModeOf } from "./identity.js";

/** Models callers may request when `voice.allowedModels` is unset. */
export const DEFAULT_VOICE_MODELS: readonly string[] = [
  voiceProvider("xai").defaultModel,
  voiceProvider("openai").defaultModel,
];

const KNOWN_PROVIDERS = new Set(["xai", "openai"]);

/** Typed voice-endpoint failure; `message` is safe to return to callers. */
export class VoiceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VoiceRequestError";
  }
}

/** True when REST requests reach handlers without a verified bearer token. */
export function restIsUnauthenticated(config: Pick<ServerConfig, "auth" | "authDisabled" | "authToken">): boolean {
  const mode = authModeOf(config);
  if (mode === "oidc") return false;
  return mode === "none" || !config.authToken;
}

export async function mintVoiceClientSecret(
  body: { provider?: string; model?: string },
  config: Pick<ServerConfig, "auth" | "authDisabled" | "authToken" | "voice"> = {},
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ token: string; expiresAt?: string; url: string; model: string; provider: string }> {
  if (restIsUnauthenticated(config)) {
    if (!config.voice?.allowUnauthenticated) {
      throw new VoiceRequestError(
        403,
        "VOICE_AUTH_REQUIRED",
        "Voice token minting is disabled while server auth is off. Configure OIDC (FLOWGRAPH_OIDC_ISSUER) or FLOWGRAPH_AUTH_TOKEN, " +
          "or explicitly opt in with FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED=1 (voice.allowUnauthenticated).",
      );
    }
    log("warn", "voice.unauthenticated-mint", {
      message: "Minting a voice token without REST auth (voice.allowUnauthenticated is on).",
    });
  }

  if (body.provider !== undefined && !KNOWN_PROVIDERS.has(body.provider)) {
    throw new VoiceRequestError(400, "VOICE_PROVIDER_NOT_ALLOWED", `Unknown voice provider "${String(body.provider)}".`);
  }
  const provider = voiceProvider(body.provider);
  const model = body.model ?? provider.defaultModel;
  const allowed = config.voice?.allowedModels?.length ? config.voice.allowedModels : DEFAULT_VOICE_MODELS;
  if (typeof model !== "string" || !allowed.includes(model)) {
    throw new VoiceRequestError(
      400,
      "VOICE_MODEL_NOT_ALLOWED",
      `Voice model "${String(model)}" is not allowed. Allowed: ${allowed.join(", ")}.`,
    );
  }

  const envName = apiKeyEnvForVoice(provider.id);
  let apiKey = process.env[envName]?.trim() ?? "";
  if (!apiKey && provider.id === "xai") {
    apiKey = process.env["GROK_API_KEY"]?.trim() ?? "";
  }
  if (!apiKey) {
    log("warn", "voice.not-configured", { provider: provider.id, missing: envName });
    throw new VoiceRequestError(503, "VOICE_NOT_CONFIGURED", `Voice sessions are not configured on this server.`);
  }

  let minted: Awaited<ReturnType<typeof mintEphemeralToken>>;
  try {
    minted = await mintEphemeralToken({
      apiKey,
      provider: provider.id,
      model,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (err) {
    // Upstream detail (status, body) stays in server logs only.
    log("error", "voice.mint-failed", { provider: provider.id, model, ...errorFields(err) });
    throw new VoiceRequestError(502, "VOICE_MINT_FAILED", "Failed to mint a voice session token.");
  }
  return {
    token: minted.token,
    ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
    url: minted.url,
    model: minted.model,
    provider: minted.provider,
  };
}

/** Startup warnings for the voice endpoint policy. */
export function logVoicePolicy(config: Pick<ServerConfig, "auth" | "authDisabled" | "authToken" | "voice">): void {
  if (config.voice?.allowUnauthenticated && restIsUnauthenticated(config)) {
    log("warn", "voice.allow-unauthenticated", {
      message:
        "!!! FLOWGRAPH_VOICE_ALLOW_UNAUTHENTICATED is on and REST auth is off: anyone who can reach this port " +
        "can mint realtime voice tokens billed to this server's XAI_API_KEY/OPENAI_API_KEY. Local/dev only. !!!",
    });
  }
}
