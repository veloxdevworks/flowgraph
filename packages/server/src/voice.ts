import { mintEphemeralToken, apiKeyEnvForVoice, voiceProvider } from "@flowgraph/workshop-session";

export async function mintVoiceClientSecret(body: {
  provider?: string;
  model?: string;
}): Promise<{ token: string; expiresAt?: string; url: string; model: string; provider: string }> {
  const envName = apiKeyEnvForVoice(body.provider);
  let apiKey = process.env[envName]?.trim() ?? "";
  if (!apiKey && voiceProvider(body.provider).id === "xai") {
    apiKey = process.env["GROK_API_KEY"]?.trim() ?? "";
  }
  if (!apiKey) {
    throw new Error(`Invalid voice request: missing ${envName} for voice sessions.`);
  }
  const minted = await mintEphemeralToken({
    apiKey,
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  });
  return {
    token: minted.token,
    ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
    url: minted.url,
    model: minted.model,
    provider: minted.provider,
  };
}
