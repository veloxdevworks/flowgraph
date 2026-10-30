export type {
  WorkshopAgendaItem,
  WorkshopVoiceHints,
  WorkshopLimits,
  WorkshopDiff,
  WorkshopContract,
  WorkshopTranscriptTurn,
  WorkshopResume,
} from "@flowgraph/spec";

/** Rough realtime voice price, for client-side cost estimates only. */
export const WORKSHOP_VOICE_USD_PER_MINUTE = 0.05;
/** Session wall-clock cap when the contract has no `limits.maxMinutes`. */
export const WORKSHOP_SESSION_MAX_MS = 30 * 60 * 1000;

export type VoiceProviderId = "xai" | "openai";

export type VoiceProvider = {
  id: VoiceProviderId;
  realtimeUrl: (model: string) => string;
  mintUrl: string;
  defaultModel: string;
  defaultVoice: string;
  voices: string[];
};

export type MintedVoiceToken = {
  token: string;
  expiresAt?: string;
  url: string;
  model: string;
  provider: VoiceProviderId;
};
