export type WorkshopAgendaItem = {
  id: string;
  title: string;
  description?: string;
};

export type WorkshopVoiceHints = {
  provider?: string;
  model?: string;
  voice?: string;
};

export type WorkshopLimits = {
  maxMinutes?: number;
  maxTurns?: number;
};

/** Interrupt payload the engine sends to a client. */
export type WorkshopContract = {
  agenda: WorkshopAgendaItem[];
  schema?: Record<string, unknown>;
  context?: unknown;
  facilitator?: string;
  voice?: WorkshopVoiceHints;
  artifacts?: string[];
  diffStat?: string;
  limits?: WorkshopLimits;
  fallback?: "form" | "text" | "json" | string;
};

export type WorkshopTranscriptTurn = {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at?: string;
};

export type WorkshopResume = {
  output: Record<string, unknown>;
  transcript: WorkshopTranscriptTurn[];
  coverage: Record<string, boolean | string>;
  endedReason: string;
};

export const WORKSHOP_VOICE_USD_PER_MINUTE = 0.05;
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
