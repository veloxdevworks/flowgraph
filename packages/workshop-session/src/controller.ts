import { checkWorkshopOutput, uncoveredAgendaItems } from "@flowgraph/spec";
import { appendPath, deepMerge, isPlainObject, setPath } from "./draft.js";
import {
  CONTROLLER_TOOL_NAMES,
  schemaHasRisksList,
  workshopTools,
  type FacilitatorToolCall,
  type FacilitatorToolDef,
} from "./tools.js";
import {
  WORKSHOP_SESSION_MAX_MS,
  type WorkshopContract,
  type WorkshopResume,
  type WorkshopTranscriptTurn,
} from "./types.js";

export const DEFAULT_MAX_CONTEXT_CHARS = 12_000;

export type WorkshopState = {
  readonly draft: Readonly<Record<string, unknown>>;
  readonly coverage: Readonly<Record<string, boolean | string>>;
  readonly transcript: readonly WorkshopTranscriptTurn[];
  readonly endedReason?: string;
  /** Number of user turns so far. */
  readonly turns: number;
  readonly startedAt: string;
  readonly updatedAt: string;
};

/** Compact "what is left" summary attached to every tool result. */
export type WorkshopStatus = {
  /** Required top-level schema fields not yet in the draft. */
  missing: string[];
  /** Agenda ids not yet covered. */
  uncovered: string[];
  /** Draft satisfies the schema (and coverage, when the contract requires it). */
  complete: boolean;
  /** Remaining user turns; present only with `limits.maxTurns`. */
  turnsLeft?: number;
  /** Set once the turn limit is reached: the facilitator should call finish now. */
  wrapUp?: true;
  /** Why the draft is not complete when that is not explained by `missing` / `uncovered`. */
  issue?: string;
};

export type WorkshopCheck = { complete: boolean; error?: string; missing: string[]; uncovered: string[] };

export type ApplyResult = {
  ok: boolean;
  /** Always an object carrying `status`; failures carry `error`. */
  result: Record<string, unknown> & { status: WorkshopStatus };
  /** True when this call ended the session. */
  ended?: boolean;
};

export type WorkshopSnapshot = {
  version: 1;
  /** Hash of agenda ids + schema; `restore` refuses a snapshot from another contract. */
  fingerprint: string;
  draft: Record<string, unknown>;
  coverage: Record<string, boolean | string>;
  transcript: WorkshopTranscriptTurn[];
  endedReason?: string;
  turns: number;
  startedAt: string;
  updatedAt: string;
};

export type WorkshopControllerOptions = {
  now?: () => Date;
  /** Primed context longer than this is truncated in `instructions()`. Default 12000. */
  maxContextChars?: number;
};

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Two FNV-1a style 32-bit passes, hex. Not cryptographic: a drift check only. */
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Stable fingerprint of the parts of a contract a snapshot depends on. */
export function contractFingerprint(contract: Pick<WorkshopContract, "agenda" | "schema">): string {
  return hash(stableStringify({ agenda: contract.agenda.map((a) => a.id), schema: contract.schema ?? null }));
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Owns the state of one workshop session (draft, coverage, transcript, limits) and
 * produces the resume value. No I/O: drive it from a text model (`TextFacilitator`),
 * the voice socket (`WorkshopSession`), or a form (`setField`).
 */
export class WorkshopController {
  private s: WorkshopState;
  private readonly listeners = new Set<(state: WorkshopState) => void>();
  private readonly now: () => Date;
  private readonly maxContextChars: number;

  constructor(
    readonly contract: WorkshopContract,
    opts: WorkshopControllerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.maxContextChars = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    const at = this.now().toISOString();
    this.s = { draft: {}, coverage: {}, transcript: [], turns: 0, startedAt: at, updatedAt: at };
  }

  /** Rebuild a controller from `snapshot()`. Throws on a wrong version or a different contract. */
  static restore(
    contract: WorkshopContract,
    snapshot: WorkshopSnapshot,
    opts: WorkshopControllerOptions = {},
  ): WorkshopController {
    if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) {
      throw new Error("unsupported workshop snapshot version");
    }
    if (snapshot.fingerprint !== contractFingerprint(contract)) {
      throw new Error("workshop snapshot belongs to a different contract (agenda or schema changed)");
    }
    if (!isPlainObject(snapshot.draft) || !isPlainObject(snapshot.coverage) || !Array.isArray(snapshot.transcript)) {
      throw new Error("malformed workshop snapshot");
    }
    const c = new WorkshopController(contract, opts);
    const copy = clone(snapshot);
    c.s = {
      draft: copy.draft,
      coverage: copy.coverage,
      transcript: copy.transcript,
      turns: copy.turns,
      startedAt: copy.startedAt,
      updatedAt: copy.updatedAt,
      ...(copy.endedReason !== undefined ? { endedReason: copy.endedReason } : {}),
    };
    return c;
  }

  get state(): WorkshopState {
    return this.s;
  }

  get ended(): boolean {
    return this.s.endedReason !== undefined;
  }

  /** Fires after every change with the new state. Returns an unsubscribe function. */
  subscribe(listener: (state: WorkshopState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get limits(): { maxTurns?: number; maxMinutes?: number; timeLimitMs: number } {
    const { maxTurns, maxMinutes } = this.contract.limits ?? {};
    return {
      ...(typeof maxTurns === "number" && maxTurns > 0 ? { maxTurns } : {}),
      ...(typeof maxMinutes === "number" && maxMinutes > 0 ? { maxMinutes } : {}),
      timeLimitMs:
        typeof maxMinutes === "number" && maxMinutes > 0 ? maxMinutes * 60_000 : WORKSHOP_SESSION_MAX_MS,
    };
  }

  /** True once user turns reach `limits.maxTurns`. */
  get turnLimitReached(): boolean {
    const max = this.limits.maxTurns;
    return max !== undefined && this.s.turns >= max;
  }

  private update(patch: Partial<Omit<{ -readonly [K in keyof WorkshopState]: WorkshopState[K] }, "updatedAt">>): void {
    this.s = { ...this.s, ...patch, updatedAt: this.now().toISOString() };
    for (const l of [...this.listeners]) {
      try {
        l(this.s);
      } catch {
        // a faulty listener must not break the session
      }
    }
  }

  private assertOpen(): void {
    if (this.ended) throw new Error("workshop session already ended");
  }

  // ---- validation --------------------------------------------------------------

  private missingFields(): string[] {
    const required = this.contract.schema?.["required"];
    if (!Array.isArray(required)) return [];
    return required.filter(
      (k): k is string => typeof k === "string" && (this.s.draft[k] === undefined || this.s.draft[k] === null),
    );
  }

  /** Would the session be accepted as `completed` right now? */
  check(): WorkshopCheck {
    const uncovered = uncoveredAgendaItems(this.contract.agenda, this.s.coverage);
    const r = checkWorkshopOutput(this.s.draft, {
      schema: this.contract.schema,
      endedReason: "completed",
      requireCoverage: this.contract.requireCoverage,
      agenda: this.contract.agenda,
      coverage: this.s.coverage,
      label: "draft",
    });
    return {
      complete: r.complete,
      ...(r.error ? { error: r.error } : {}),
      missing: this.missingFields(),
      uncovered,
    };
  }

  status(): WorkshopStatus {
    const c = this.check();
    const status: WorkshopStatus = { missing: c.missing, uncovered: c.uncovered, complete: c.complete };
    const max = this.limits.maxTurns;
    if (max !== undefined) {
      status.turnsLeft = Math.max(0, max - this.s.turns);
      if (this.turnLimitReached) status.wrapUp = true;
    }
    const uncoveredBlocks = this.contract.requireCoverage && c.uncovered.length > 0;
    if (!c.complete && c.error && c.missing.length === 0 && !uncoveredBlocks) status.issue = c.error;
    return status;
  }

  // ---- mutation ----------------------------------------------------------------

  /** Set a value at a dot path. Throws on a bad path or after the session ended. */
  setField(path: string, value: unknown): void {
    this.assertOpen();
    this.update({ draft: setPath(this.s.draft as Record<string, unknown>, path, value) });
  }

  /** Deep-merge a patch (arrays replaced). */
  updateDraft(patch: Record<string, unknown>): void {
    this.assertOpen();
    this.update({ draft: deepMerge(this.s.draft as Record<string, unknown>, patch) });
  }

  appendToList(path: string, item: unknown): void {
    this.assertOpen();
    this.update({ draft: appendPath(this.s.draft as Record<string, unknown>, path, item) });
  }

  /** Mark an agenda item covered. Throws on an id that is not on the agenda. */
  cover(id: string, notes?: string): void {
    this.assertOpen();
    if (!this.contract.agenda.some((a) => a.id === id)) {
      throw new Error(`unknown agenda item '${id}' (valid: ${this.contract.agenda.map((a) => a.id).join(", ")})`);
    }
    this.update({ coverage: { ...this.s.coverage, [id]: notes ? notes : true } });
  }

  /**
   * Record a transcript turn; user turns count toward `limits.maxTurns`. Turns arriving
   * after the session ended are ignored (a voice socket may deliver a late transcript).
   */
  addTurn(turn: WorkshopTranscriptTurn): void {
    if (this.ended) return;
    const t: WorkshopTranscriptTurn = { ...turn, at: turn.at ?? this.now().toISOString() };
    this.update({
      transcript: [...this.s.transcript, t],
      turns: this.s.turns + (t.role === "user" ? 1 : 0),
    });
  }

  /**
   * End the session. Obeys the same rule as the engine: throws (session stays open) unless
   * the draft passes `checkWorkshopOutput` for `reason`, so only `human_ended` / `timeout` /
   * `skipped` can end early, and only when the contract sets `allowPartial`.
   */
  end(reason = "completed"): void {
    this.assertOpen();
    const r = checkWorkshopOutput(this.s.draft, {
      schema: this.contract.schema,
      endedReason: reason,
      allowPartial: this.contract.allowPartial,
      requireCoverage: this.contract.requireCoverage,
      agenda: this.contract.agenda,
      coverage: this.s.coverage,
      label: "draft",
    });
    if (r.error) throw new Error(`Session not ended. ${r.error}`);
    this.update({ endedReason: reason });
  }

  // ---- tools -------------------------------------------------------------------

  tools(opts: { readArtifact?: boolean } = {}): FacilitatorToolDef[] {
    return workshopTools(this.contract, opts);
  }

  /** Whether `apply` serves this tool name (false for `read_artifact` and unknown names). */
  handles(name: string): boolean {
    if (name === "add_risk") return schemaHasRisksList(this.contract.schema);
    return (CONTROLLER_TOOL_NAMES as readonly string[]).includes(name);
  }

  /** Apply one facilitator tool call. Never throws; failures are `{ ok: false, result: { error } }`. */
  apply(call: FacilitatorToolCall): ApplyResult {
    const done = (ok: boolean, body: Record<string, unknown>, ended?: boolean): ApplyResult => ({
      ok,
      result: { ...body, status: this.status() },
      ...(ended ? { ended: true } : {}),
    });
    const fail = (error: string) => done(false, { error });
    if (this.ended) return fail("workshop session already ended");
    const a = call.args ?? {};
    try {
      switch (call.name) {
        case "set_field": {
          if (!("value" in a)) return fail("set_field needs 'value'");
          this.setField(String(a["path"] ?? ""), a["value"]);
          return done(true, { path: String(a["path"]) });
        }
        case "update_draft": {
          if (!isPlainObject(a["patch"])) return fail("update_draft needs a 'patch' object");
          this.updateDraft(a["patch"]);
          return done(true, { updated: Object.keys(a["patch"]) });
        }
        case "append_to_list": {
          if (!("item" in a)) return fail("append_to_list needs 'item'");
          this.appendToList(String(a["path"] ?? ""), a["item"]);
          return done(true, { path: String(a["path"]) });
        }
        case "add_risk": {
          if (!this.handles("add_risk")) return fail("unknown tool add_risk");
          const risk = typeof a["risk"] === "string" ? a["risk"] : "";
          if (!risk) return fail("add_risk needs a non-empty 'risk'");
          this.appendToList("risks", risk);
          return done(true, { risks: this.s.draft["risks"] });
        }
        case "cover_agenda_item": {
          this.cover(String(a["id"] ?? ""), typeof a["notes"] === "string" ? a["notes"] : undefined);
          return done(true, { covered: String(a["id"]) });
        }
        case "finish": {
          const reason = typeof a["reason"] === "string" && a["reason"] ? a["reason"] : "completed";
          this.end(reason);
          return done(true, { endedReason: reason }, true);
        }
        default:
          return fail(`unknown tool ${call.name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- prompts -----------------------------------------------------------------

  /** Last turns of the transcript that fit in `maxChars`, as plain text. */
  seedTranscript(maxChars = 6_000): string {
    const lines: string[] = [];
    let used = 0;
    for (let i = this.s.transcript.length - 1; i >= 0; i--) {
      const t = this.s.transcript[i]!;
      if (t.role !== "user" && t.role !== "assistant") continue;
      const line = `${t.role === "user" ? "Human" : "Facilitator"}: ${t.text}`;
      if (used + line.length + 1 > maxChars) {
        if (lines.length === 0) lines.push(line.slice(-maxChars));
        break;
      }
      lines.unshift(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  /**
   * System prompt: facilitator text, agenda, schema, (truncated) context, the engine's
   * validation error if this is a re-prompt, the live draft and coverage when resuming,
   * and a wrap-up order once the turn limit is reached.
   * `seedTranscript`: `true` appends the recent transcript; a string is appended verbatim.
   */
  instructions(opts: { seedTranscript?: boolean | string } = {}): string {
    const c = this.contract;
    const agenda = c.agenda
      .map((a) => `- ${a.id}: ${a.title}${a.description ? ` - ${a.description}` : ""}`)
      .join("\n");
    const schema = c.schema ? JSON.stringify(c.schema) : "{}";
    let context = typeof c.context === "string" ? c.context : c.context ? JSON.stringify(c.context) : "";
    if (context.length > this.maxContextChars) {
      context = `${context.slice(0, this.maxContextChars)}\n[context truncated: ${context.length - this.maxContextChars} more characters]`;
    }
    const parts: string[] = [
      c.facilitator ?? "You facilitate a workshop. Cover the agenda. Do not invent requirements.",
      "Record facts as they land: set_field / update_draft / append_to_list for the output, cover_agenda_item when a topic is done. Every tool result says what is still missing. Call finish when the output is complete, or when the human asks to stop. If finish returns an error, the session is still open: ask the human for what is missing.",
      `Agenda:\n${agenda || "(none)"}`,
      `Output JSON Schema:\n${schema}`,
    ];
    if (c.requireCoverage) parts.push("Every agenda item must be covered before the session can complete.");
    if (c.allowPartial) {
      parts.push('If the human ends the session early, call finish with reason "human_ended"; an unfinished draft is accepted then.');
    }
    if (context) parts.push(`Primed context:\n${context}`);
    if (c.artifactRefs?.length) parts.push(`Artifacts:\n${c.artifactRefs.map((r) => `- ${r}`).join("\n")}`);
    if (c.diffStat) parts.push(`Change summary:\n${c.diffStat}`);
    if (c.validationError) {
      const n = c.attempt !== undefined && c.maxAttempts !== undefined ? ` (attempt ${c.attempt} of ${c.maxAttempts})` : "";
      parts.push(`The previous answer was rejected${n}: ${c.validationError}\nFix exactly that with the human.`);
    }
    const resuming =
      Object.keys(this.s.draft).length > 0 || Object.keys(this.s.coverage).length > 0 || this.s.transcript.length > 0;
    if (resuming) {
      parts.push(
        `Session in progress. Current draft:\n${JSON.stringify(this.s.draft)}\nCovered agenda items:\n${JSON.stringify(this.s.coverage)}`,
      );
    }
    if (this.turnLimitReached) {
      parts.push("The turn limit has been reached. Wrap up now: record anything outstanding and call finish.");
    } else if (this.limits.maxTurns !== undefined) {
      parts.push(`Turn budget: ${this.limits.maxTurns - this.s.turns} human turn(s) left.`);
    }
    if (typeof opts.seedTranscript === "string" && opts.seedTranscript) {
      parts.push(`Prior transcript (continue this meeting):\n${opts.seedTranscript}`);
    } else if (opts.seedTranscript === true) {
      const seed = this.seedTranscript();
      if (seed) parts.push(`Prior transcript (continue this meeting):\n${seed}`);
    }
    return parts.join("\n\n");
  }

  // ---- output ------------------------------------------------------------------

  /** The resume value for the engine. Throws if the session has not ended. */
  toResume(): WorkshopResume {
    if (this.s.endedReason === undefined) throw new Error("workshop session has not ended; call end() first");
    return {
      output: clone(this.s.draft) as Record<string, unknown>,
      transcript: clone([...this.s.transcript]),
      coverage: clone(this.s.coverage) as Record<string, boolean | string>,
      endedReason: this.s.endedReason,
    };
  }

  snapshot(): WorkshopSnapshot {
    return clone({
      version: 1 as const,
      fingerprint: contractFingerprint(this.contract),
      draft: this.s.draft as Record<string, unknown>,
      coverage: this.s.coverage as Record<string, boolean | string>,
      transcript: [...this.s.transcript],
      ...(this.s.endedReason !== undefined ? { endedReason: this.s.endedReason } : {}),
      turns: this.s.turns,
      startedAt: this.s.startedAt,
      updatedAt: this.s.updatedAt,
    });
  }
}
