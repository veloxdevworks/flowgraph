import type { VoiceProvider, VoiceProviderId } from "./types.js";

export const XAI_VOICE: VoiceProvider = {
  id: "xai",
  realtimeUrl: (model) => `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
  mintUrl: "https://api.x.ai/v1/realtime/client_secrets",
  defaultModel: "grok-voice-latest",
  defaultVoice: "eve",
  voices: ["eve", "ara", "rex", "sal", "leo"],
};

export const OPENAI_VOICE: VoiceProvider = {
  id: "openai",
  realtimeUrl: (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
  mintUrl: "https://api.openai.com/v1/realtime/client_secrets",
  defaultModel: "gpt-4o-realtime-preview",
  defaultVoice: "alloy",
  voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
};

const BY_ID: Record<VoiceProviderId, VoiceProvider> = {
  xai: XAI_VOICE,
  openai: OPENAI_VOICE,
};

export function voiceProvider(id?: string): VoiceProvider {
  if (id === "openai") return OPENAI_VOICE;
  return BY_ID[(id as VoiceProviderId) ?? "xai"] ?? XAI_VOICE;
}
