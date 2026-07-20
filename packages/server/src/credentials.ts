/**
 * Server-side credential resolution for hosted runs.
 *
 * Remote clients must NOT send provider secrets. Bedrock uses the container
 * IAM role / default AWS credential chain; vendor API keys come from the
 * process environment (injected via Secrets Manager / task env).
 */

const CLIENT_SECRET_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CURSOR_API_KEY",
]);

export class ClientSecretsRejectedError extends Error {
  constructor(keys: string[]) {
    super(
      `Remote runs reject client-supplied secrets (${keys.join(", ")}). ` +
        "Configure credentials on the server (IAM role for Bedrock, Secrets Manager / env for API keys).",
    );
    this.name = "ClientSecretsRejectedError";
  }
}

/** Throw if the client payload includes provider secret env vars. */
export function rejectClientSecrets(env: Record<string, string> | undefined): void {
  if (!env || Object.keys(env).length === 0) return;
  const hit = Object.keys(env).filter((k) => CLIENT_SECRET_KEYS.has(k) || /_API_KEY$/i.test(k));
  if (hit.length > 0) {
    throw new ClientSecretsRejectedError(hit);
  }
  // Any non-empty env from the client is rejected in v1 for safety.
  throw new ClientSecretsRejectedError(Object.keys(env));
}

/**
 * Apply server credential defaults (region) onto process.env.
 * Does not invent secrets — relies on IAM / injected env.
 */
export function applyServerCredentials(opts: { awsRegion?: string } = {}): void {
  if (opts.awsRegion) {
    process.env.AWS_REGION ??= opts.awsRegion;
    process.env.AWS_DEFAULT_REGION ??= opts.awsRegion;
  }
}

/** Describe which credential sources are available (for /healthz / diagnostics). */
export function credentialStatus(): {
  awsRegion: string | null;
  hasAwsKeys: boolean;
  hasBedrockIamHint: boolean;
  vendorKeys: string[];
} {
  const vendorKeys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
  ].filter((k) => Boolean(process.env[k]));

  return {
    awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null,
    hasAwsKeys: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    // In ECS/AgentCore the task/runtime role supplies creds without static keys.
    hasBedrockIamHint: Boolean(
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
        process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
        process.env.AWS_PROFILE ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    ),
    vendorKeys,
  };
}
