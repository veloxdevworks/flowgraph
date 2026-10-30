import { voiceProvider } from "./providers.js";
import type { MintedVoiceToken, VoiceProviderId } from "./types.js";

export async function mintEphemeralToken(opts: {
  provider?: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<MintedVoiceToken> {
  const provider = voiceProvider(opts.provider);
  const model = opts.model ?? provider.defaultModel;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!opts.apiKey) {
    throw new Error(`Missing API key for ${provider.id} voice sessions.`);
  }
  const res = await fetchImpl(provider.mintUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to mint ${provider.id} voice token (${res.status}): ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as {
    value?: string;
    client_secret?: { value?: string } | string;
    expires_at?: number | string;
  };
  const token =
    (typeof json.client_secret === "string" ? json.client_secret : json.client_secret?.value) ??
    json.value;
  if (!token) {
    throw new Error(`${provider.id} mint response missing client secret.`);
  }
  const expiresAt =
    typeof json.expires_at === "number"
      ? new Date(json.expires_at * (json.expires_at < 10_000_000_000 ? 1000 : 1)).toISOString()
      : typeof json.expires_at === "string"
        ? json.expires_at
        : undefined;
  return {
    token,
    ...(expiresAt ? { expiresAt } : {}),
    url: provider.realtimeUrl(model),
    model,
    provider: provider.id as VoiceProviderId,
  };
}

export function apiKeyEnvForVoice(provider?: string): string {
  return voiceProvider(provider).id === "openai" ? "OPENAI_API_KEY" : "XAI_API_KEY";
}
