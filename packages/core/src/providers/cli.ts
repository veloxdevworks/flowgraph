/**
 * Local CLI agent provider — shells out to Claude Code / Cursor / Codex / Grok.
 *
 * v1 is single-shot (prompt → text response). Tool-calling and streaming are
 * left to the installed CLI's own agent loop; flowgraph does not mediate tools.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  defineProvider,
  type AgentRequest,
  type AgentResult,
  type ProviderAdapter,
  type ProviderRunContext,
} from "./types.js";

const execFile = promisify(execFileCb);

export type CliVendor = "claude" | "cursor" | "codex" | "grok";

const DEFAULT_BINARIES: Record<CliVendor, string> = {
  claude: "claude",
  cursor: "cursor-agent",
  codex: "codex",
  grok: "grok",
};

export interface CliProviderOptions {
  name: string;
  vendor: CliVendor;
  model?: string;
  cwd?: string;
  /** Override the binary name/path (defaults per vendor). */
  binary?: string;
  /** Injected for tests. */
  execFileFn?: typeof execFile;
  /** Injected for tests. */
  detectFn?: (binary: string) => Promise<boolean>;
}

export function defaultBinaryFor(vendor: CliVendor): string {
  return DEFAULT_BINARIES[vendor];
}

/** Map a non-cli provider kind/vendor to a local CLI vendor when possible. */
export function cliVendorForProviderKind(
  kind: string,
  vendor?: string,
): CliVendor | undefined {
  if (kind === "cli") {
    if (vendor === "claude" || vendor === "cursor" || vendor === "codex" || vendor === "grok") {
      return vendor;
    }
    return undefined;
  }
  if (kind === "claude") return "claude";
  if (kind === "cursor") return "cursor";
  if (kind === "langchain") {
    if (vendor === "openai") return "codex";
    if (vendor === "xai") return "grok";
    if (vendor === "anthropic") return "claude";
  }
  return undefined;
}

/** Env var that the SDK-based provider for this kind would require. */
export function apiKeyEnvForProviderKind(kind: string, vendor?: string): string | undefined {
  if (kind === "claude") return "ANTHROPIC_API_KEY";
  if (kind === "cursor") return "CURSOR_API_KEY";
  if (kind === "langchain") {
    switch (vendor) {
      case "anthropic":
        return "ANTHROPIC_API_KEY";
      case "google":
        return "GOOGLE_API_KEY";
      case "xai":
        return "XAI_API_KEY";
      case "ollama":
        return undefined;
      case "openai":
      default:
        return "OPENAI_API_KEY";
    }
  }
  return undefined;
}

export function hasApiKey(envName: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!envName) return false;
  const v = env[envName];
  return typeof v === "string" && v.trim().length > 0;
}

export async function detectLocalCli(
  vendorOrBinary: CliVendor | string,
  opts: { binary?: string; detectFn?: (binary: string) => Promise<boolean> } = {},
): Promise<{ ok: boolean; binary: string }> {
  const binary =
    opts.binary ??
    (vendorOrBinary in DEFAULT_BINARIES
      ? DEFAULT_BINARIES[vendorOrBinary as CliVendor]
      : vendorOrBinary);
  const detect = opts.detectFn ?? checkBinOnPath;
  const ok = await detect(binary);
  return { ok, binary };
}

async function checkBinOnPath(name: string): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFile(cmd, [name]);
    return true;
  } catch {
    return false;
  }
}

function buildArgs(vendor: CliVendor, prompt: string, model?: string): string[] {
  switch (vendor) {
    case "claude": {
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      return args;
    }
    case "cursor": {
      const args = ["-p", prompt];
      if (model) args.push("--model", model);
      return args;
    }
    case "codex": {
      const args = ["exec", prompt];
      if (model) args.push("-m", model);
      return args;
    }
    case "grok": {
      const args = ["-p", prompt];
      if (model) args.push("-m", model);
      return args;
    }
  }
}

function parseCliStdout(vendor: CliVendor, stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  // Claude JSON / Grok streaming-json: try to parse; fall back to raw text.
  if (vendor === "claude" || vendor === "grok") {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        // Claude Code JSON often has `result` or `content`
        if (typeof obj.result === "string") return obj.result;
        if (typeof obj.content === "string") return obj.content;
        return parsed;
      }
      return parsed;
    } catch {
      // Grok may emit NDJSON — take the last non-empty line that parses.
      const lines = trimmed.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]!) as unknown;
          if (parsed && typeof parsed === "object") {
            const obj = parsed as Record<string, unknown>;
            if (typeof obj.result === "string") return obj.result;
            if (typeof obj.content === "string") return obj.content;
            if (typeof obj.text === "string") return obj.text;
          }
          return parsed;
        } catch {
          /* keep scanning */
        }
      }
      return trimmed;
    }
  }

  return trimmed;
}

export function createCliProvider(options: CliProviderOptions): ProviderAdapter {
  const vendor = options.vendor;
  const binary = options.binary ?? defaultBinaryFor(vendor);
  const runExec = options.execFileFn ?? execFile;
  const detectFn = options.detectFn;

  return defineProvider({
    name: options.name,
    capabilities: {
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      ...(options.model ? { models: [options.model] } : {}),
    },

    async run(req: AgentRequest, ctx: ProviderRunContext): Promise<AgentResult> {
      const detected = await detectLocalCli(vendor, { binary, ...(detectFn ? { detectFn } : {}) });
      if (!detected.ok) {
        throw new Error(
          `Local CLI provider "${options.name}": binary "${binary}" not found on PATH. ` +
            `Install the ${vendor} CLI or set providers.${options.name}.binary.`,
        );
      }

      const prompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
      const model = req.model ?? options.model;
      const args = buildArgs(vendor, prompt, model);
      const cwd = options.cwd ?? ctx.node.workspace;

      ctx.emit("step", { provider: options.name, vendor, binary, model });

      try {
        const { stdout, stderr } = await runExec(binary, args, {
          cwd,
          maxBuffer: 20 * 1024 * 1024,
          signal: ctx.signal,
          env: process.env,
        });
        if (stderr?.trim()) {
          ctx.node.logger.debug(`[cli:${vendor}] stderr: ${stderr.trim().slice(0, 500)}`);
        }
        const output = parseCliStdout(vendor, stdout);
        return {
          output,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.prompt },
            {
              role: "assistant" as const,
              content: typeof output === "string" ? output : JSON.stringify(output),
            },
          ],
          steps: [{ type: "message", text: typeof output === "string" ? output : JSON.stringify(output) }],
          stopReason: "done",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Local CLI provider "${options.name}" (${binary}) failed: ${msg}`, {
          cause: err,
        });
      }
    },
  });
}
