import type { Interface as ReadlineInterface } from "node:readline";
import type { InterruptInfo } from "@flowgraph/core";
import type { WorkshopContract } from "@flowgraph/spec";
import type { FacilitatorModel, WorkshopController } from "@flowgraph/workshop-session";
import { parseInterruptAnswer, formatInterruptPrompt } from "./interrupts.js";

/** Small I/O surface so the session can be driven by scripted input in tests. */
export interface WorkshopIO {
  /** Show `prompt`, return the line typed, or `null` on EOF / Ctrl-C. */
  ask(prompt: string): Promise<string | null>;
  write(text: string): void;
  /** Aborted when the human hits Ctrl-C / closes the input (cancels an in-flight model call). */
  signal?: AbortSignal;
}

/** Thrown when the human walks away and the session cannot be ended cleanly. */
export class WorkshopAbortError extends Error {
  constructor(message = "Workshop prompt aborted.") {
    super(message);
    this.name = "WorkshopAbortError";
  }
}

/**
 * `WorkshopIO` over a readline interface. Lines are queued, so input that arrives while the
 * model is thinking is not lost. Ctrl-C (or the input closing) makes `ask` return null.
 * Call `dispose()` to detach the listeners and leave the interface usable for other prompts.
 */
export function createReadlineIO(
  rl: ReadlineInterface,
  write: (text: string) => void = (t) => console.log(t),
): WorkshopIO & { dispose(): void } {
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let done = false;
  const aborter = new AbortController();
  const finish = (): void => {
    if (done) return;
    done = true;
    aborter.abort();
    const w = waiter;
    waiter = undefined;
    w?.(null);
  };
  const onLine = (line: string): void => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(line);
    } else queue.push(line);
  };
  rl.on("line", onLine);
  rl.on("close", finish);
  rl.on("SIGINT", finish);
  return {
    signal: aborter.signal,
    write,
    ask(prompt) {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (done) return Promise.resolve(null);
      const nl = prompt.lastIndexOf("\n");
      if (nl >= 0) write(prompt.slice(0, nl));
      rl.setPrompt(prompt.slice(nl + 1));
      rl.prompt();
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    dispose() {
      rl.off("line", onLine);
      rl.off("close", finish);
      rl.off("SIGINT", finish);
    },
  };
}

// ---- model configuration ----------------------------------------------------------

export const WORKSHOP_MODEL_ENV = "FLOWGRAPH_WORKSHOP_MODEL";

export type WorkshopModelConfig = {
  vendor: "anthropic" | "openai" | "xai";
  model: string;
  apiKey: string;
  baseUrl?: string;
};

export type WorkshopModelResolution =
  | { status: "unset" }
  | { status: "ok"; config: WorkshopModelConfig }
  | { status: "invalid"; error: string };

type Env = Record<string, string | undefined>;

/** Parse `FLOWGRAPH_WORKSHOP_MODEL=<vendor>:<model>` and look up the vendor's API key. Never echoes a key. */
export function resolveWorkshopModel(env: Env = process.env): WorkshopModelResolution {
  const raw = env[WORKSHOP_MODEL_ENV]?.trim();
  if (!raw) return { status: "unset" };
  const idx = raw.indexOf(":");
  const bad = (why: string): WorkshopModelResolution => ({
    status: "invalid",
    error: `${WORKSHOP_MODEL_ENV}: ${why} (expected <vendor>:<model>, vendors: anthropic, openai, xai)`,
  });
  if (idx < 0) return bad(`'${raw}' has no ':'`);
  const vendor = raw.slice(0, idx).trim().toLowerCase();
  const model = raw.slice(idx + 1).trim();
  if (!model) return bad("model id is empty");
  const key = (...names: string[]): { name: string; value: string } | undefined => {
    for (const n of names) {
      const v = env[n]?.trim();
      if (v) return { name: n, value: v };
    }
    return undefined;
  };
  switch (vendor) {
    case "anthropic": {
      const k = key("ANTHROPIC_API_KEY");
      if (!k) return { status: "invalid", error: `${WORKSHOP_MODEL_ENV}=anthropic:… needs ANTHROPIC_API_KEY to be set` };
      return { status: "ok", config: { vendor, model, apiKey: k.value } };
    }
    case "openai": {
      const k = key("OPENAI_API_KEY");
      if (!k) return { status: "invalid", error: `${WORKSHOP_MODEL_ENV}=openai:… needs OPENAI_API_KEY to be set` };
      return { status: "ok", config: { vendor, model, apiKey: k.value } };
    }
    case "xai": {
      const k = key("XAI_API_KEY", "GROK_API_KEY");
      if (!k) return { status: "invalid", error: `${WORKSHOP_MODEL_ENV}=xai:… needs XAI_API_KEY (or GROK_API_KEY) to be set` };
      return { status: "ok", config: { vendor, model, apiKey: k.value, baseUrl: "https://api.x.ai/v1" } };
    }
    default:
      return bad(`unknown vendor '${vendor}'`);
  }
}

async function buildModel(cfg: WorkshopModelConfig): Promise<FacilitatorModel> {
  const ws = await import("@flowgraph/workshop-session");
  if (cfg.vendor === "anthropic") return ws.anthropicModel({ apiKey: cfg.apiKey, model: cfg.model });
  return ws.openAICompatibleModel({
    apiKey: cfg.apiKey,
    model: cfg.model,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
  });
}

// ---- helpers ---------------------------------------------------------------------

type Prop = Record<string, unknown>;

function contractFrom(it: InterruptInfo): WorkshopContract {
  const payload = it.payload as { data?: unknown } | undefined;
  const data = (payload && typeof payload === "object" ? payload.data : undefined) as Partial<WorkshopContract> | undefined;
  const base = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Partial<WorkshopContract>;
  return {
    ...base,
    mode: "workshop",
    agenda: Array.isArray(base.agenda) ? base.agenda : [],
    fallback: base.fallback ?? "form",
    ...(it.validationError !== undefined ? { validationError: it.validationError } : {}),
    ...(it.attempt !== undefined ? { attempt: it.attempt } : {}),
    ...(it.maxAttempts !== undefined ? { maxAttempts: it.maxAttempts } : {}),
  } as WorkshopContract;
}

function schemaProps(contract: WorkshopContract): Array<{ key: string; prop: Prop; required: boolean }> {
  const schema = contract.schema;
  const props = schema?.["properties"];
  if (!props || typeof props !== "object") return [];
  const required = Array.isArray(schema?.["required"]) ? (schema!["required"] as unknown[]) : [];
  return Object.entries(props as Record<string, unknown>).map(([key, p]) => ({
    key,
    prop: p && typeof p === "object" ? (p as Prop) : {},
    required: required.includes(key),
  }));
}

function declaredType(prop: Prop): string | undefined {
  const t = prop["type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((x): x is string => typeof x === "string" && x !== "null");
  return undefined;
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

function parseScalar(type: string | undefined, raw: string): Parsed {
  const text = raw.trim();
  switch (type) {
    case "number":
    case "integer": {
      const n = Number(text);
      if (text === "" || !Number.isFinite(n)) return { ok: false, error: `'${text}' is not a number` };
      if (type === "integer" && !Number.isInteger(n)) return { ok: false, error: `'${text}' is not an integer` };
      return { ok: true, value: n };
    }
    case "boolean": {
      const l = text.toLowerCase();
      if (["y", "yes", "true", "1"].includes(l)) return { ok: true, value: true };
      if (["n", "no", "false", "0"].includes(l)) return { ok: true, value: false };
      return { ok: false, error: "answer y or n" };
    }
    case "object": {
      try {
        const v = JSON.parse(text) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v };
      } catch {
        /* fall through */
      }
      return { ok: false, error: "enter a JSON object, e.g. {\"name\": \"Ada\"}" };
    }
    case "string":
      return { ok: true, value: raw };
    default: {
      // no declared type: JSON if it parses, otherwise the text
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: true, value: raw };
      }
    }
  }
}

function typeLabel(prop: Prop): string {
  const t = declaredType(prop);
  if (t === "array") {
    const it = prop["items"];
    const itemType = it && typeof it === "object" ? declaredType(it as Prop) : undefined;
    return `array${itemType ? ` of ${itemType}` : ""}`;
  }
  const en = prop["enum"];
  if (Array.isArray(en) && en.length) return `${t ?? "value"}, one of: ${en.map((v) => JSON.stringify(v)).join(" | ")}`;
  return t ?? "any";
}

function oneLine(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function agendaTitle(a: { id: string; title?: string }): string {
  return a.title ?? a.id;
}

/** One compact status block: agenda marks, what is missing, turns. */
export function formatWorkshopPanel(controller: WorkshopController): string {
  const { agenda } = controller.contract;
  const cov = controller.state.coverage;
  const st = controller.status();
  const marks = agenda.map((a) => `${cov[a.id] ? "[x]" : "[ ]"} ${a.id}`).join("  ");
  const bits: string[] = [];
  if (st.missing.length) bits.push(`missing: ${st.missing.join(", ")}`);
  if (st.uncovered.length && controller.contract.requireCoverage) bits.push(`uncovered: ${st.uncovered.join(", ")}`);
  if (st.complete) bits.push("ready to finish");
  if (st.turnsLeft !== undefined) bits.push(`${st.turnsLeft} turn(s) left`);
  return `  ${marks || "(no agenda)"}${bits.length ? `\n  ${bits.join(" | ")}` : ""}`;
}

// ---- entry point -----------------------------------------------------------------

export type WorkshopInteractiveOptions = {
  io: WorkshopIO;
  env?: Env;
  /** Test hook: use this model for chat instead of building one from the environment. */
  model?: FacilitatorModel;
};

type Mode = "chat" | "form" | "json";

/**
 * Run an interactive workshop for a `workshop` interrupt and return its resume value.
 * Throws `WorkshopAbortError` when the human leaves and the contract does not allow ending early.
 */
export async function runWorkshopInteractive(it: InterruptInfo, opts: WorkshopInteractiveOptions): Promise<unknown> {
  const { io } = opts;
  const contract = contractFrom(it);
  const resolution: WorkshopModelResolution = opts.model
    ? { status: "ok", config: { vendor: "openai", model: "injected", apiKey: "" } }
    : resolveWorkshopModel(opts.env ?? process.env);

  io.write(`\n${it.reason ?? "Workshop"}`);
  if (it.validationError) {
    const budget = it.maxAttempts ? ` (attempt ${it.attempt ?? "?"} of ${it.maxAttempts})` : "";
    io.write(`Previous answer rejected${budget}: ${it.validationError}`);
  }
  if (resolution.status === "invalid") io.write(`Note: ${resolution.error}. Chat is unavailable.`);

  const chatAvailable = resolution.status === "ok";
  const mode = await chooseMode(io, contract, chatAvailable);

  const { WorkshopController: Controller } = await import("@flowgraph/workshop-session");
  const controller = new Controller(contract);

  if (mode === "json") return askJson(it, io);
  if (mode === "form") return runForm(controller, io);
  const model = opts.model ?? (await buildModel((resolution as { config: WorkshopModelConfig }).config));
  return runChat(controller, model, io, it);
}

async function chooseMode(io: WorkshopIO, contract: WorkshopContract, chatAvailable: boolean): Promise<Mode> {
  const def: Mode = chatAvailable ? "chat" : contract.fallback === "json" ? "json" : "form";
  const options: Array<[Mode, string]> = [];
  if (chatAvailable) options.push(["chat", "talk it through with an AI facilitator"]);
  options.push(["form", "fill in the agenda and each field yourself"]);
  options.push(["json", "paste the full resume value as JSON"]);
  io.write("How do you want to take part?");
  options.forEach(([m, d], i) => io.write(`  ${i + 1}) ${m.padEnd(4)} ${d}${m === def ? "  (default)" : ""}`));
  for (;;) {
    const ans = await io.ask(`Choose [${def}]: `);
    if (ans === null) throw new WorkshopAbortError();
    const t = ans.trim().toLowerCase();
    if (t === "") return def;
    const n = Number(t);
    const byNum = Number.isInteger(n) ? options[n - 1]?.[0] : undefined;
    const byName = options.find(([m]) => m === t)?.[0];
    const picked = byNum ?? byName;
    if (picked) return picked;
    if (t === "chat") io.write("Chat is not available: set FLOWGRAPH_WORKSHOP_MODEL=<vendor>:<model> and the vendor's API key.");
    else io.write(`Pick ${options.map(([m]) => m).join(", ")} (or its number).`);
  }
}

async function askJson(it: InterruptInfo, io: WorkshopIO): Promise<unknown> {
  // the rejection (if any) was already shown above
  const { validationError: _v, attempt: _a, maxAttempts: _m, exhausted: _e, ...rest } = it;
  const ans = await io.ask(formatInterruptPrompt(rest as InterruptInfo));
  if (ans === null) throw new WorkshopAbortError();
  return parseInterruptAnswer(it, ans);
}

// ---- chat ------------------------------------------------------------------------

function tryEnd(controller: WorkshopController, reason: string): { ok: true } | { ok: false; error: string } {
  try {
    controller.end(reason);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).replace(/^Session not ended\.\s*/, "") };
  }
}

async function runChat(
  controller: WorkshopController,
  model: FacilitatorModel,
  io: WorkshopIO,
  it: InterruptInfo,
): Promise<unknown> {
  const { TextFacilitator } = await import("@flowgraph/workshop-session");
  const fac = new TextFacilitator(controller, model);
  const walkAway = (): unknown => {
    const r = tryEnd(controller, "human_ended");
    if (r.ok) return controller.toResume();
    throw new WorkshopAbortError();
  };
  const signalOpt = io.signal ? { signal: io.signal } : {};

  io.write("Chat with the facilitator. /status /draft /form /end /json /help; Ctrl-C ends the session.");
  io.write(formatWorkshopPanel(controller));

  const show = (reply: string): void => {
    if (reply) io.write(`\n${reply}`);
    io.write(formatWorkshopPanel(controller));
  };
  const fail = (err: unknown): void => {
    io.write(`Facilitator error: ${err instanceof Error ? err.message : String(err)}`);
    io.write("Try again, or type /form to continue by hand.");
  };

  try {
    const first = await fac.start(signalOpt);
    show(first.reply);
    if (first.ended) return controller.toResume();
  } catch (err) {
    if (io.signal?.aborted) return walkAway();
    fail(err);
  }

  for (;;) {
    const line = await io.ask("\nyou> ");
    if (line === null) return walkAway();
    const text = line.trim();
    if (text === "") continue;

    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0]!.toLowerCase();
      if (cmd === "/status") {
        io.write(formatWorkshopPanel(controller));
        const c = controller.check();
        io.write(c.complete ? "  The draft is complete." : `  ${c.error ?? "The draft is incomplete."}`);
      } else if (cmd === "/draft") {
        io.write(JSON.stringify(controller.state.draft, null, 2));
      } else if (cmd === "/form") {
        io.write("Switching to the form; your draft and coverage are kept.");
        return runForm(controller, io);
      } else if (cmd === "/json") {
        const ans = await io.ask('Paste the resume JSON ({ "output", ... } or the output object), blank to cancel: ');
        if (ans === null) return walkAway();
        if (ans.trim() === "") continue;
        try {
          const v = JSON.parse(ans.trim()) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v)) return parseInterruptAnswer(it, ans);
        } catch {
          /* fall through */
        }
        io.write("That is not a JSON object; staying in the chat.");
      } else if (cmd === "/end") {
        const r = tryEnd(controller, "human_ended");
        if (r.ok) return controller.toResume();
        io.write(`Cannot end yet: ${r.error}`);
        io.write("Keep going, or use /form to finish by hand.");
      } else {
        io.write("Commands: /status (what is left), /draft (current output), /form (fill in by hand), /end (stop, if allowed), /json (paste a resume).");
      }
      continue;
    }

    try {
      const r = await fac.send(text, signalOpt);
      show(r.reply);
      if (r.stepLimitReached) io.write("(The facilitator took many steps without a final answer; say something to continue.)");
      if (controller.ended) return controller.toResume();
    } catch (err) {
      if (io.signal?.aborted) return walkAway();
      fail(err);
    }
  }
}

// ---- form ------------------------------------------------------------------------

async function runForm(controller: WorkshopController, io: WorkshopIO): Promise<unknown> {
  const contract = controller.contract;
  const props = schemaProps(contract);
  const abort = (): unknown => {
    const r = tryEnd(controller, "human_ended");
    if (r.ok) return controller.toResume();
    throw new WorkshopAbortError();
  };

  // 1. agenda
  if (contract.agenda.length) {
    io.write("\nAgenda: confirm each item (Enter), type a note, or 'skip' to leave it open.");
    for (let i = 0; i < contract.agenda.length; i++) {
      const a = contract.agenda[i]!;
      if (controller.state.coverage[a.id]) {
        io.write(`  ${i + 1}/${contract.agenda.length} ${agendaTitle(a)}: already covered`);
        continue;
      }
      const desc = a.description ? ` - ${a.description}` : "";
      const ans = await io.ask(`  ${i + 1}/${contract.agenda.length} ${agendaTitle(a)}${desc}\n  covered? `);
      if (ans === null) return abort();
      const t = ans.trim();
      if (t.toLowerCase() === "skip") continue;
      controller.cover(a.id, t || undefined);
    }
  }

  // 2. fields
  if (props.length) io.write("\nOutput fields (Enter skips an optional field).");
  for (const p of props) {
    const r = await askField(controller, io, p);
    if (r === "eof") return abort();
  }

  // 3. end
  for (;;) {
    const r = tryEnd(controller, "completed");
    if (r.ok) return controller.toResume();
    io.write(`\nNot accepted: ${r.error}`);
    if (contract.allowPartial) {
      const ans = await io.ask("Fix it, or end early as human_ended (the output stays incomplete)? [fix/end] ");
      if (ans === null) return abort();
      if (ans.trim().toLowerCase().startsWith("e")) {
        const e = tryEnd(controller, "human_ended");
        if (e.ok) return controller.toResume();
        io.write(`Cannot end early: ${e.error}`);
      }
    }
    const check = controller.check();
    const failing = props.filter(
      (p) => check.missing.includes(p.key) || r.error.includes(`field "${p.key}"`),
    );
    const coverageBlocks = Boolean(contract.requireCoverage) && check.uncovered.length > 0;
    if (coverageBlocks) {
      for (const id of check.uncovered) {
        const a = contract.agenda.find((x) => x.id === id)!;
        const ans = await io.ask(`  ${agendaTitle(a)} is not covered. Enter to confirm, or a note: `);
        if (ans === null) return abort();
        if (ans.trim().toLowerCase() !== "skip") controller.cover(id, ans.trim() || undefined);
      }
    }
    const redo = failing.length || coverageBlocks ? failing : props;
    for (const p of redo) {
      const res = await askField(controller, io, p, { force: true });
      if (res === "eof") return abort();
    }
  }
}

/** Ask for one field; returns "eof" if input ended. `force` (after a rejection) does not accept a blank "keep". */
async function askField(
  controller: WorkshopController,
  io: WorkshopIO,
  p: { key: string; prop: Prop; required: boolean },
  opts: { force?: boolean } = {},
): Promise<"ok" | "eof"> {
  const { key, prop, required } = p;
  const type = declaredType(prop);
  const current = controller.state.draft[key];
  const hasCurrent = current !== undefined && current !== null;
  const desc = typeof prop["description"] === "string" ? ` - ${prop["description"]}` : "";
  const keep = hasCurrent ? ` [current: ${oneLine(current)}; Enter keeps it]` : "";
  const hint =
    type === "array"
      ? "one item per line, blank line to finish (or a JSON array)"
      : type === "boolean"
        ? "y/n"
        : type === "object"
          ? "JSON object"
          : "";
  io.write(`\n${key} (${typeLabel(prop)}, ${required ? "required" : "optional"})${desc}${keep}${hint ? `\n  ${hint}` : ""}`);

  for (;;) {
    const raw = await io.ask(`${key}> `);
    if (raw === null) return "eof";
    if (raw.trim() === "") {
      if (opts.force) {
        io.write("  The current value was rejected; enter a new one.");
        continue;
      }
      if (hasCurrent || !required) return "ok";
      io.write("  This field is required.");
      continue;
    }
    const parsed = type === "array" ? await readArray(io, prop, raw) : parseScalar(type, raw);
    if (!parsed.ok) {
      io.write(`  ${parsed.error}`);
      continue;
    }
    controller.setField(key, parsed.value);
    return "ok";
  }
}

async function readArray(io: WorkshopIO, prop: Prop, first: string): Promise<Parsed> {
  const items = prop["items"];
  const itemType = items && typeof items === "object" ? declaredType(items as Prop) : undefined;
  if (first.trim().startsWith("[")) {
    try {
      const v = JSON.parse(first.trim()) as unknown;
      if (Array.isArray(v)) return { ok: true, value: v };
    } catch {
      /* fall through */
    }
    return { ok: false, error: "that looks like JSON but is not a valid array" };
  }
  const out: unknown[] = [];
  let line: string | null = first;
  while (line !== null && line.trim() !== "") {
    const item = itemType && itemType !== "string" ? parseScalar(itemType, line) : { ok: true as const, value: line.trim() };
    if (!item.ok) {
      io.write(`  item '${line.trim()}': ${item.error}; try that line again`);
    } else {
      out.push(item.value);
    }
    line = await io.ask("  + ");
  }
  return { ok: true, value: out };
}
