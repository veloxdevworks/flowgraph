import { describe, expect, it, vi } from "vitest";
import { WorkshopController } from "./controller.js";
import type { WorkshopContract } from "./types.js";

const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    owner: { type: "object", properties: { name: { type: "string" } } },
    risks: { type: "array", items: { type: "string" } },
    tags: { type: "array" },
  },
  required: ["title"],
};

function contract(extra: Partial<WorkshopContract> = {}): WorkshopContract {
  return {
    mode: "workshop",
    agenda: [
      { id: "scope", title: "Scope" },
      { id: "risks", title: "Risks", description: "what could go wrong" },
    ],
    fallback: "form",
    schema,
    ...extra,
  };
}

const call = (name: string, args: Record<string, unknown>) => ({ name, callId: "c", args });

describe("WorkshopController tools", () => {
  it("advertises schema-aware tools", () => {
    const names = (c: WorkshopContract, o?: { readArtifact?: boolean }) =>
      new WorkshopController(c).tools(o).map((t) => t.name);
    expect(names(contract())).toEqual([
      "set_field",
      "update_draft",
      "append_to_list",
      "cover_agenda_item",
      "add_risk",
      "finish",
    ]);
    expect(names(contract({ schema: { type: "object", properties: { title: { type: "string" } } } }))).not.toContain(
      "add_risk",
    );
    expect(names(contract({ schema: undefined }))).not.toContain("add_risk");
    expect(names(contract())).not.toContain("read_artifact");
    expect(names(contract(), { readArtifact: true })).toContain("read_artifact");
    const cover = new WorkshopController(contract()).tools().find((t) => t.name === "cover_agenda_item")!;
    expect(JSON.stringify(cover.parameters)).toContain('"enum":["scope","risks"]');
  });

  it("set_field uses dot paths and creates intermediate objects", () => {
    const c = new WorkshopController(contract());
    const r = c.apply(call("set_field", { path: "owner.name", value: "Ada" }));
    expect(r.ok).toBe(true);
    expect(c.state.draft).toEqual({ owner: { name: "Ada" } });
    c.apply(call("set_field", { path: "a.b.c", value: 1 }));
    expect((c.state.draft as any).a.b.c).toBe(1);
    expect(r.result.status.missing).toEqual(["title"]);
    expect(c.apply(call("set_field", { path: "title.x", value: 1 })).ok).toBe(true); // title unset -> object
    expect(c.apply(call("set_field", { path: "__proto__.x", value: 1 })).ok).toBe(false);
    expect(c.apply(call("set_field", { path: "", value: 1 })).ok).toBe(false);
    expect(c.apply(call("set_field", { path: "x" })).ok).toBe(false);
  });

  it("refuses a path through a scalar", () => {
    const c = new WorkshopController(contract());
    c.setField("title", "SSO");
    expect(() => c.setField("title.sub", 1)).toThrow(/not an object/);
  });

  it("update_draft deep-merges objects and replaces arrays", () => {
    const c = new WorkshopController(contract());
    c.setField("owner", { name: "Ada", team: "core" });
    c.setField("tags", ["a", "b"]);
    const r = c.apply(call("update_draft", { patch: { owner: { name: "Bob" }, tags: ["c"], title: "T" } }));
    expect(r.ok).toBe(true);
    expect(c.state.draft).toEqual({ owner: { name: "Bob", team: "core" }, tags: ["c"], title: "T" });
    expect(c.apply(call("update_draft", { patch: "x" })).ok).toBe(false);
    // prototype pollution is ignored
    c.apply(call("update_draft", { patch: JSON.parse('{"__proto__":{"polluted":true}}') }));
    expect(({} as any).polluted).toBeUndefined();
  });

  it("append_to_list creates, appends, and rejects non-lists", () => {
    const c = new WorkshopController(contract());
    c.apply(call("append_to_list", { path: "tags", item: "a" }));
    c.apply(call("append_to_list", { path: "tags", item: "b" }));
    expect(c.state.draft["tags"]).toEqual(["a", "b"]);
    c.setField("title", "x");
    expect(c.apply(call("append_to_list", { path: "title", item: "b" })).ok).toBe(false);
  });

  it("add_risk appends to risks only when the schema has them", () => {
    const c = new WorkshopController(contract());
    c.apply(call("add_risk", { risk: "migration" }));
    expect(c.state.draft["risks"]).toEqual(["migration"]);
    const plain = new WorkshopController(contract({ schema: { type: "object" } }));
    expect(plain.apply(call("add_risk", { risk: "x" })).ok).toBe(false);
  });

  it("cover_agenda_item rejects unknown ids", () => {
    const c = new WorkshopController(contract());
    const bad = c.apply(call("cover_agenda_item", { id: "nope" }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.result)).toContain("scope, risks");
    expect(c.apply(call("cover_agenda_item", { id: "scope", notes: "done" })).ok).toBe(true);
    c.cover("risks");
    expect(c.state.coverage).toEqual({ scope: "done", risks: true });
    expect(() => c.cover("zzz")).toThrow();
  });

  it("status lists what is left on every result", () => {
    const c = new WorkshopController(contract());
    const r = c.apply(call("cover_agenda_item", { id: "scope" }));
    expect(r.result.status).toEqual({ missing: ["title"], uncovered: ["risks"], complete: false });
    c.setField("title", "T");
    expect(c.status()).toEqual({ missing: [], uncovered: ["risks"], complete: true });
  });

  it("unknown tools fail with a status", () => {
    const r = new WorkshopController(contract()).apply(call("read_artifact", { path: "x" }));
    expect(r.ok).toBe(false);
    expect(r.result.status).toBeDefined();
  });
});

describe("finish / end", () => {
  it("is refused then accepted", () => {
    const c = new WorkshopController(contract());
    const no = c.apply(call("finish", {}));
    expect(no.ok).toBe(false);
    expect(no.ended).toBeUndefined();
    expect(JSON.stringify(no.result)).toContain("title");
    expect(c.ended).toBe(false);
    c.setField("title", "T");
    const yes = c.apply(call("finish", {}));
    expect(yes).toMatchObject({ ok: true, ended: true });
    expect(c.state.endedReason).toBe("completed");
    expect(c.apply(call("set_field", { path: "x", value: 1 })).ok).toBe(false);
    expect(() => c.setField("x", 1)).toThrow(/ended/);
  });

  it("requireCoverage blocks completed until every item is covered", () => {
    const c = new WorkshopController(contract({ requireCoverage: true }));
    c.setField("title", "T");
    c.cover("scope");
    const r = c.apply(call("finish", {}));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.result)).toContain("risks");
    c.cover("risks");
    expect(c.apply(call("finish", {})).ended).toBe(true);
  });

  it("allowPartial allows early end, but only with a partial reason", () => {
    const c = new WorkshopController(contract({ allowPartial: true }));
    expect(c.apply(call("finish", { reason: "completed" })).ok).toBe(false);
    expect(() => c.end("completed")).toThrow(/not ended/);
    c.end("human_ended");
    expect(c.toResume()).toMatchObject({ endedReason: "human_ended", output: {} });
  });

  it("without allowPartial a partial reason is refused; a wrongly typed draft is refused even with it", () => {
    const c = new WorkshopController(contract());
    expect(() => c.end("human_ended")).toThrow();
    const p = new WorkshopController(contract({ allowPartial: true }));
    p.setField("title", 5);
    expect(() => p.end("human_ended")).toThrow();
  });

  it("toResume needs an ended session", () => {
    expect(() => new WorkshopController(contract()).toResume()).toThrow();
  });
});

describe("limits", () => {
  it("counts user turns and tells the facilitator to wrap up", () => {
    const c = new WorkshopController(contract({ limits: { maxTurns: 2, maxMinutes: 5 } }));
    expect(c.limits).toEqual({ maxTurns: 2, maxMinutes: 5, timeLimitMs: 300_000 });
    c.addTurn({ role: "assistant", text: "hi" });
    c.addTurn({ role: "user", text: "a" });
    expect(c.status().turnsLeft).toBe(1);
    expect(c.status().wrapUp).toBeUndefined();
    expect(c.instructions()).toContain("1 human turn(s) left");
    c.addTurn({ role: "user", text: "b" });
    expect(c.status()).toMatchObject({ turnsLeft: 0, wrapUp: true });
    expect(c.instructions()).toContain("Wrap up now");
    expect(c.apply(call("update_draft", { patch: {} })).result.status.wrapUp).toBe(true);
  });

  it("defaults the time limit and omits turn fields without maxTurns", () => {
    const c = new WorkshopController(contract());
    expect(c.limits).toEqual({ timeLimitMs: 30 * 60_000 });
    expect(c.status().turnsLeft).toBeUndefined();
  });
});

describe("instructions", () => {
  it("includes agenda, schema, facilitator text and truncates context", () => {
    const c = new WorkshopController(contract({ facilitator: "Be brief.", context: "x".repeat(500) }), {
      maxContextChars: 100,
    });
    const text = c.instructions();
    expect(text).toContain("Be brief.");
    expect(text).toContain("- risks: Risks - what could go wrong");
    expect(text).toContain('"required":["title"]');
    expect(text).toContain("context truncated: 400 more characters");
    expect(text).not.toContain("x".repeat(101));
    expect(text).not.toContain("Session in progress");
  });

  it("shows the validation error, and the draft when resuming", () => {
    const c = new WorkshopController(contract({ validationError: "owner missing", attempt: 2, maxAttempts: 3 }));
    expect(c.instructions()).toContain("rejected (attempt 2 of 3): owner missing");
    c.setField("title", "T");
    c.cover("scope");
    const text = c.instructions();
    expect(text).toContain('{"title":"T"}');
    expect(text).toContain('{"scope":true}');
  });

  it("seedTranscript keeps the newest turns within the budget", () => {
    const c = new WorkshopController(contract());
    for (let i = 0; i < 20; i++) c.addTurn({ role: i % 2 ? "assistant" : "user", text: `message-${i}` });
    const seed = c.seedTranscript(60);
    expect(seed).toContain("message-19");
    expect(seed).not.toContain("message-0");
    expect(seed.length).toBeLessThanOrEqual(60);
    expect(c.instructions({ seedTranscript: true })).toContain("Prior transcript");
    expect(c.instructions({ seedTranscript: "custom" })).toContain("custom");
  });
});

describe("snapshot / restore / subscribe", () => {
  it("round-trips through JSON", () => {
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    const c = new WorkshopController(contract({ requireCoverage: true }), { now });
    c.setField("title", "T");
    c.cover("scope", "n");
    c.addTurn({ role: "user", text: "hello" });
    const snap = JSON.parse(JSON.stringify(c.snapshot()));
    expect(snap.version).toBe(1);
    const r = WorkshopController.restore(contract({ requireCoverage: true }), snap);
    expect(r.state).toMatchObject({ draft: { title: "T" }, coverage: { scope: "n" }, turns: 1 });
    expect(r.state.transcript[0]?.text).toBe("hello");
    expect(r.state.startedAt).toBe(c.state.startedAt);
    expect(r.snapshot()).toEqual(c.snapshot());
    expect(r.instructions()).toContain("Session in progress");
    r.cover("risks");
    r.end();
    const again = WorkshopController.restore(contract({ requireCoverage: true }), r.snapshot());
    expect(again.ended).toBe(true);
  });

  it("does not alias the snapshot or the resume", () => {
    const c = new WorkshopController(contract());
    c.setField("owner", { name: "A" });
    const snap = c.snapshot();
    (snap.draft["owner"] as any).name = "mutated";
    expect((c.state.draft as any).owner.name).toBe("A");
  });

  it("refuses a snapshot from a different contract or version", () => {
    const snap = new WorkshopController(contract()).snapshot();
    expect(() =>
      WorkshopController.restore(contract({ schema: { ...schema, required: ["title", "owner"] } }), snap),
    ).toThrow(/different contract/);
    expect(() =>
      WorkshopController.restore(contract({ agenda: [{ id: "other", title: "x" }] }), snap),
    ).toThrow(/different contract/);
    expect(() => WorkshopController.restore(contract(), { ...snap, version: 2 as never })).toThrow(/version/);
    // key order of the schema does not matter; titles are not part of the fingerprint
    const reordered = { required: schema.required, properties: schema.properties, type: "object" };
    expect(() =>
      WorkshopController.restore(contract({ schema: reordered, agenda: [{ id: "scope", title: "Renamed" }, { id: "risks", title: "R" }] }), snap),
    ).not.toThrow();
  });

  it("notifies subscribers on every change until unsubscribed", () => {
    const c = new WorkshopController(contract());
    const fn = vi.fn();
    const off = c.subscribe(fn);
    c.setField("title", "T");
    c.cover("scope");
    c.addTurn({ role: "user", text: "x" });
    c.apply(call("update_draft", { patch: { a: 1 } }));
    expect(fn).toHaveBeenCalledTimes(4);
    expect(fn.mock.calls[0]![0].draft).toEqual({ title: "T" });
    c.subscribe(() => {
      throw new Error("bad listener");
    });
    c.setField("b", 1);
    expect(fn).toHaveBeenCalledTimes(5);
    off();
    c.setField("c", 1);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
