/**
 * `steps` flows: what the status means, what is kept, and what is recorded. Playwright is a
 * stand-in here, found through the workspace's node_modules, so these tests pin the rules and
 * not the browser. ADR-0019 requires a real browser run too, and that a person opens the output.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DemoWithSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import type { NodeRunContext } from "../context.js";
import { demoToolExposureDiagnostics } from "../runtime/validate-graph.js";
import { demoNode, type DemoResult } from "./demo.js";
import { readDemoManifest } from "./demo-manifest.js";

const THREAD = "steps-thread";
const NODE = "prove";
const OBJECTIVE = "A signed-in user can complete checkout";
const made: string[] = [];

type Scene = {
  /** Text and selectors that are on the page and visible. */
  visible?: string[];
  url?: string;
  /** HTTP status per URL (default 200). */
  status?: Record<string, number>;
  /** Thrown by navigation to any URL containing the key. */
  gotoError?: Record<string, string>;
  consoleErrors?: string[];
  pageErrors?: string[];
  /** Playwright's own error for a click, which can quote what it was given. */
  clickError?: string;
  /** Screenshots fail, by name fragment. "*" fails all of them. */
  shotError?: string;
  noVideo?: boolean;
  launchError?: string;
  /** Long waits never finish by themselves, only when the context closes. */
  hangLongWaits?: boolean;
};

function fakeWorkspace(scene: Scene = {}): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fg-demo-steps-"));
  made.push(workspace);
  const dir = path.join(workspace, "node_modules", "playwright");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright", main: "index.mjs" }));
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
     import { join } from "node:path";
     import { fileURLToPath } from "node:url";
     const scene = ${JSON.stringify(scene)};
     const log = (line) => appendFileSync(fileURLToPath(new URL("../../playwright.log", import.meta.url)), line + "\\n");
     const visible = new Set(scene.visible ?? []);
     let shut = () => {};
     const closed = new Promise((_resolve, reject) => { shut = () => reject(new Error("Target page, context or browser has been closed")); });
     closed.catch(() => {});
     const locator = (selector) => {
       const self = {
         filter: () => self,
         first: () => self,
         click: async ({ timeout }) => {
           log("click " + selector);
           if (scene.clickError) throw new Error(scene.clickError);
           if (!visible.has(selector)) throw new Error("locator.click: Timeout " + timeout + "ms exceeded.\\nCall log:\\n  waiting for " + selector);
         },
         fill: async (value) => {
           log("fill " + selector);
           if (!visible.has(selector)) throw new Error("locator.fill: Timeout exceeded.");
         },
         waitFor: async ({ state, timeout }) => {
           const there = visible.has(selector);
           if (state === "hidden" ? there : !there) throw new Error("locator.waitFor: Timeout " + timeout + "ms exceeded.");
         },
       };
       return self;
     };
     export const chromium = {
       launch: async () => {
         log("launch");
         ${scene.launchError ? `throw new Error(${JSON.stringify(scene.launchError)});` : ""}
         return {
           close: async () => { log("browser.close"); shut(); },
           newContext: async (options) => {
             const raw = join(options.recordVideo.dir, "raw.webm");
             log("record " + (options.recordVideo ? "on" : "off"));
             return {
               close: async () => {
                 log("context.close");
                 shut();
                 if (!scene.noVideo) writeFileSync(raw, "webm");
               },
               newPage: async () => {
                 const handlers = {};
                 const page = {
                   on: (event, handler) => { handlers[event] = handler; },
                   goto: async (url) => {
                     log("goto " + url);
                     for (const [key, message] of Object.entries(scene.gotoError ?? {})) {
                       if (url.includes(key)) throw new Error(message);
                     }
                     for (const text of scene.consoleErrors ?? []) handlers.console?.({ type: () => "error", text: () => text });
                     for (const text of scene.pageErrors ?? []) handlers.pageerror?.(new Error(text));
                     handlers.console?.({ type: () => "log", text: () => "not an error" });
                     page.at = url;
                     const status = scene.status?.[url] ?? 200;
                     return { status: () => status };
                   },
                   at: scene.url ?? "http://app/",
                   url: () => page.at,
                   locator,
                   getByText: locator,
                   keyboard: { press: async (key) => log("press " + key) },
                   waitForSelector: async (selector) => { if (!visible.has(selector)) throw new Error("page.waitForSelector: Timeout exceeded."); },
                   waitForTimeout: async (ms) => { if (scene.hangLongWaits && ms >= 60000) { log("hang"); await closed; } },
                   waitForURL: async (glob) => { if (glob !== page.at) throw new Error("page.waitForURL: Timeout exceeded."); },
                   screenshot: async ({ path }) => {
                     log("screenshot " + path.split("/").pop());
                     if (scene.shotError === "*" || (scene.shotError && path.includes(scene.shotError))) throw new Error("screenshot failed");
                     writeFileSync(path, "png");
                   },
                   video: () => ({ path: async () => raw }),
                 };
                 return page;
               },
             };
           },
         };
       },
     };`,
  );
  return workspace;
}

const logOf = (workspace: string): string[] =>
  fs.readFileSync(path.join(workspace, "playwright.log"), "utf8").trim().split("\n");

const folderOf = (workspace: string): string => path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE);

const filesIn = (workspace: string): string[] =>
  fs.existsSync(folderOf(workspace)) ? fs.readdirSync(folderOf(workspace)) : [];

async function run(
  workspace: string,
  withConfig: Record<string, unknown>,
  opts: { signal?: AbortSignal; issues?: Array<Record<string, any>> } = {},
) {
  const issues = opts.issues ?? [];
  const compiled = demoNode.build({ graphName: "g" }, { id: NODE }, DemoWithSchema.parse(withConfig) as never);
  const ctx = {
    nodeId: NODE,
    nodeType: "demo",
    attempt: 1,
    workspace,
    meta: { runId: "run", threadId: THREAD, startedAt: new Date().toISOString(), graph: "g" },
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit() {},
    issue: (issue: Record<string, unknown>) => issues.push(issue),
    _input: {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as unknown as NodeRunContext;
  const res = await compiled.run({}, ctx);
  const { update } = res as unknown as { update: { outputs: Record<string, DemoResult> } };
  return { out: update.outputs[NODE]!, issues };
}

const flow = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  objective: OBJECTIVE,
  target: { web: { url: "http://app/start", stepTimeout: "1s" } },
  steps,
  ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("demo steps: status", () => {
  it("passes when every step and assertion held, and keeps the evidence with the literal checks", async () => {
    const workspace = fakeWorkspace({ visible: ["#email", "Sign in", "Order confirmed"] });
    const { out, issues } = await run(
      workspace,
      flow([
        { fill: { selector: "#email", value: "tester@example.com" } },
        { click: "Sign in" },
        { press: "Enter" },
        { screenshot: "Signed in!" },
        { expect: { text: "Order confirmed" } },
      ]),
    );

    expect(out).toMatchObject({ status: "passed", ok: true, kind: "steps", objective: OBJECTIVE, reason: null, pageStatus: 200 });
    expect(out.assertions).toEqual([{ check: "text: Order confirmed", positive: true, held: true }]);
    expect(out.steps?.map((s) => [s.index, s.action, s.ok])).toEqual([
      [0, "open", true],
      [1, "fill", true],
      [2, "click", true],
      [3, "press", true],
      [4, "screenshot", true],
      [5, "expect", true],
    ]);
    expect(out.steps?.[1]?.detail).toBe("#email = tester@example.com");
    expect(issues).toEqual([]);

    expect(out.path).toMatch(/-final\.png$/);
    expect(out.artifacts.map((a) => a.mimeType)).toEqual(["image/png", "image/png", "video/webm"]);
    const names = filesIn(workspace);
    expect(names).toHaveLength(3);
    expect(names.some((n) => n.includes("-04-signed-in.png"))).toBe(true);
    expect(names.some((n) => n.startsWith(".recording-"))).toBe(false);
    expect(out.extra?.map((e) => e.kind)).toEqual(["screenshot", "video"]);
  });

  it("is only inconclusive with negative checks alone, which also hold on a blank page", async () => {
    const { out } = await run(fakeWorkspace(), flow([{ expect: { hidden: "#error" } }], { expect: { noConsoleErrors: true } }));
    expect(out).toMatchObject({ status: "inconclusive", ok: true, reason: null });
    expect(out.assertions).toEqual([
      { check: "hidden: #error", positive: false, held: true },
      { check: "noConsoleErrors", positive: false, held: true },
    ]);
  });

  it("is inconclusive when nothing is asserted at all", async () => {
    const { out } = await run(fakeWorkspace({ visible: ["#go"] }), flow([{ click: "#go" }]));
    expect(out.status).toBe("inconclusive");
  });

  it("fails on an assertion that does not hold: later steps don't run, and the point of failure is kept", async () => {
    const workspace = fakeWorkspace({ visible: ["#after"] });
    const { out, issues } = await run(
      workspace,
      flow([{ expect: { text: "Order confirmed" } }, { click: "#after" }, { screenshot: "never" }]),
    );

    expect(out).toMatchObject({ status: "failed", ok: false });
    expect(out.reason).toContain("text: Order confirmed did not hold");
    expect(out.assertions).toEqual([
      { check: "text: Order confirmed", positive: true, held: false, observed: "not visible on http://app/start" },
    ]);
    expect(out.steps?.map((s) => s.ok)).toEqual([true, false]);
    const log = logOf(workspace);
    expect(log).not.toContain("click #after");
    expect(log.some((l) => l.includes("never"))).toBe(false);
    expect(log.some((l) => l.includes("-final.png"))).toBe(true);
    expect(fs.existsSync(out.path!)).toBe(true);
    expect(out.artifacts.map((a) => a.mimeType)).toEqual(["image/png", "video/webm"]);
    expect(issues.map((i) => i.code)).toEqual(["OBJECTIVE_FAILED"]);
    expect(issues[0]!["message"]).toContain(OBJECTIVE);
  });

  it("fails on a step that cannot be done, and says which", async () => {
    const { out } = await run(fakeWorkspace(), flow([{ click: "#missing" }, { expect: { text: "x" } }]));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("step 1 (click #missing): locator.click: Timeout 1000ms exceeded.");
    expect(out.steps?.at(-1)).toMatchObject({ index: 1, action: "click", ok: false });
  });

  it("checks a URL and reports where the page really is", async () => {
    const held = await run(fakeWorkspace({ visible: [] }), flow([{ expect: { url: "http://app/start" } }]));
    expect(held.out.status).toBe("passed");
    const failed = await run(fakeWorkspace(), flow([{ expect: { url: "**/account" } }]));
    expect(failed.out.assertions?.[0]).toMatchObject({ held: false, observed: "the page is at http://app/start" });
  });

  it("fails when a page opens with a bad status, unless that status is expected", async () => {
    const scene = { status: { "http://app/start": 500 }, visible: ["Oops"] };
    const failed = await run(fakeWorkspace(scene), flow([{ expect: { text: "Oops" } }]));
    expect(failed.out).toMatchObject({ status: "failed", pageStatus: 500 });
    expect(failed.out.reason).toContain("returned HTTP 500");
    expect(failed.out.steps).toEqual([expect.objectContaining({ index: 0, action: "open", ok: false })]);
    expect(failed.out.artifacts).not.toEqual([]);

    const allowed = await run(fakeWorkspace(scene), {
      ...flow([{ expect: { text: "Oops" } }]),
      target: { web: { url: "http://app/start", expect: { status: [500] } } },
    });
    expect(allowed.out.status).toBe("passed");
  });

  it("fails when a later goto returns a bad status", async () => {
    const workspace = fakeWorkspace({ status: { "http://app/broken": 503 }, visible: ["#after"] });
    const { out } = await run(workspace, flow([{ goto: "http://app/broken" }, { click: "#after" }]));
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("http://app/broken returned HTTP 503");
    expect(logOf(workspace)).not.toContain("click #after");
  });

  it("fails on a console error or uncaught page error, and caps what it keeps", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `boom ${i}`);
    const { out } = await run(
      fakeWorkspace({ visible: ["Hi"], consoleErrors: many, pageErrors: ["uncaught"] }),
      flow([{ expect: { text: "Hi" } }], { expect: { noConsoleErrors: true } }),
    );
    expect(out.status).toBe("failed");
    expect(out.console?.errors).toBe(26);
    expect(out.console?.messages).toHaveLength(20);
    expect(out.assertions?.at(-1)).toMatchObject({ check: "noConsoleErrors", positive: false, held: false });
  });

  it("records console errors without failing unless asked to", async () => {
    const { out } = await run(fakeWorkspace({ visible: ["Hi"], consoleErrors: ["noise"] }), flow([{ expect: { text: "Hi" } }]));
    expect(out.status).toBe("passed");
    expect(out.console).toEqual({ errors: 1, messages: ["noise"] });
  });

  it("stops a flow that runs past its limit, without losing the evidence", async () => {
    const { out } = await run(fakeWorkspace(), {
      ...flow([{ wait: "1m" }, { expect: { text: "x" } }]),
      target: { web: { url: "http://app/start", timeout: "50ms" } },
    });
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("past its 50ms limit");
    expect(fs.existsSync(out.path!)).toBe(true);
  });

  it("refuses to run code in the page through an address", async () => {
    const workspace = fakeWorkspace();
    const { out } = await run(workspace, flow([{ goto: "javascript:alert(1)" }]));
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("javascript: addresses are not allowed");
    expect(logOf(workspace).filter((l) => l.startsWith("goto"))).toEqual(["goto http://app/start"]);
  });
});

describe("demo steps: nothing captured", () => {
  it("is not_captured when the target can't be reached, and leaves no files", async () => {
    const workspace = fakeWorkspace({ gotoError: { start: "page.goto: net::ERR_CONNECTION_REFUSED at http://app/start" } });
    const { out, issues } = await run(workspace, flow([{ expect: { text: "x" } }]));

    expect(out).toMatchObject({ status: "not_captured", ok: false, path: null, objective: OBJECTIVE, steps: null, assertions: null, console: null });
    expect(out.reason).toContain("ERR_CONNECTION_REFUSED");
    expect(out.artifacts).toEqual([]);
    expect(filesIn(workspace)).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(["CAPTURE_FAILED"]);
    expect(logOf(workspace)).toContain("browser.close");
  });

  it("still fails only the step when a later page can't be reached", async () => {
    const { out } = await run(
      fakeWorkspace({ gotoError: { later: "page.goto: net::ERR_CONNECTION_REFUSED" } }),
      flow([{ goto: "http://app/later" }]),
    );
    expect(out.status).toBe("failed");
    expect(fs.existsSync(out.path!)).toBe(true);
  });

  it("is not_captured with the install hint when the browser is missing", async () => {
    const workspace = fakeWorkspace({ launchError: "browserType.launch: Executable doesn't exist at /x" });
    const { out, issues } = await run(workspace, flow([{ expect: { text: "x" } }]));
    expect(out.status).toBe("not_captured");
    expect(out.reason).toContain("playwright install");
    expect(issues[0]).toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("is not_captured when the browser is lost mid-flow, and keeps nothing", async () => {
    const workspace = fakeWorkspace({ clickError: "locator.click: Target page, context or browser has been closed" });
    const { out } = await run(workspace, flow([{ screenshot: "before" }, { click: "#x" }]));
    expect(out.status).toBe("not_captured");
    expect(filesIn(workspace)).toEqual([]);
  });
});

describe("demo steps: evidence", () => {
  it("keeps the status and warns when the recording is lost", async () => {
    const { out, issues } = await run(fakeWorkspace({ noVideo: true, visible: ["Hi"] }), flow([{ expect: { text: "Hi" } }]));
    expect(out.status).toBe("passed");
    expect(out.artifacts.map((a) => a.mimeType)).toEqual(["image/png"]);
    expect(issues).toEqual([expect.objectContaining({ code: "CAPTURE_FAILED", severity: "warning" })]);
    expect(issues[0]!["message"]).toContain("recording was not saved");
  });

  it("keeps the status and warns when only the final screenshot is lost", async () => {
    const { out, issues } = await run(fakeWorkspace({ shotError: "-final", visible: ["Hi"] }), flow([{ expect: { text: "Hi" } }]));
    expect(out.status).toBe("passed");
    expect(out.mimeType).toBe("video/webm");
    expect(issues[0]!["message"]).toContain("final screenshot");
  });

  it("is not_captured when no evidence survives, whatever the assertions said", async () => {
    const workspace = fakeWorkspace({ shotError: "*", noVideo: true, visible: ["Hi"] });
    const { out } = await run(workspace, flow([{ expect: { text: "Hi" } }]));
    expect(out.status).toBe("not_captured");
    expect(filesIn(workspace)).toEqual([]);
  });

  it("always records, and always takes the final screenshot", async () => {
    const workspace = fakeWorkspace({ visible: ["Hi"] });
    await run(workspace, flow([{ expect: { text: "Hi" } }]));
    const log = logOf(workspace);
    expect(log).toContain("record on");
    expect(log.some((l) => l.includes("-final.png"))).toBe(true);
  });

  it("adds the objective to the manifest", async () => {
    const workspace = fakeWorkspace({ visible: ["Hi"] });
    await run(workspace, flow([{ expect: { text: "Hi" } }]));
    expect(readDemoManifest(workspace, THREAD)[0]).toMatchObject({ status: "passed", kind: "steps", objective: OBJECTIVE });
  });
});

describe("demo steps: secrets", () => {
  const SECRET = "hunter2-super-secret";

  it("records a secret nowhere: not in steps, errors, console, assertions, the manifest or issues", async () => {
    vi.stubEnv("TEST_PASSWORD", SECRET);
    const workspace = fakeWorkspace({
      visible: ["#password"],
      consoleErrors: [`server said ${SECRET}`],
      clickError: `locator.click: bad ${SECRET}`,
    });
    const issues: Array<Record<string, unknown>> = [];
    const { out } = await run(
      workspace,
      flow([
        { fill: { selector: "#password", value: "{{ secret.TEST_PASSWORD }}" } },
        { expect: { hidden: "#gone" } },
        { click: "#x" },
      ]),
      { issues },
    );

    expect(out.status).toBe("failed");
    expect(out.steps?.[1]?.detail).toBe("#password = [REDACTED]");
    expect(out.steps?.at(-1)?.error).toContain("[REDACTED]");
    const everything = JSON.stringify({ out, issues, manifest: readDemoManifest(workspace, THREAD) });
    expect(everything).not.toContain(SECRET);
  });

  it("masks a whole fill value holding a secret too short for the general redactor", async () => {
    vi.stubEnv("TEST_PIN", "1234");
    const { out } = await run(
      fakeWorkspace({ visible: ["#pin"] }),
      flow([{ fill: { selector: "#pin", value: "{{ secret.TEST_PIN }}" } }]),
    );
    expect(out.steps?.[1]?.detail).toBe("#pin = [REDACTED]");
  });

  it("masks credentials in a URL, and leaves text that isn't a URL readable", async () => {
    const { out } = await run(fakeWorkspace(), {
      ...flow([{ expect: { hidden: "#a b" } }]),
      target: { web: { url: "http://app/start?token=abc123" } },
    });
    expect(out.steps?.[0]?.detail).not.toContain("abc123");
    expect(out.assertions?.[0]?.check).toBe("hidden: #a b");
  });
});

describe("demo steps: strict and objectives", () => {
  it("with an objective, throws unless passed", async () => {
    await expect(run(fakeWorkspace(), flow([{ expect: { hidden: "#x" } }], { strict: true }))).rejects.toThrow(/objective not shown/);
    await expect(run(fakeWorkspace(), flow([{ expect: { text: "x" } }], { strict: true }))).rejects.toThrow(/did not hold/);
    const { out } = await run(fakeWorkspace({ visible: ["x"] }), flow([{ expect: { text: "x" } }], { strict: true }));
    expect(out.status).toBe("passed");
  });

  it("without an objective, keeps today's meaning of strict", async () => {
    const { objective: _objective, ...plain } = flow([{ expect: { hidden: "#x" } }], { strict: true });
    const { out } = await run(fakeWorkspace(), plain);
    expect(out).toMatchObject({ status: "inconclusive", objective: null });
  });

  it("raises CAPTURE_FAILED, not OBJECTIVE_FAILED, for a failed flow with no objective", async () => {
    const { objective: _objective, ...plain } = flow([{ expect: { text: "x" } }]);
    const { issues } = await run(fakeWorkspace(), plain);
    expect(issues.map((i) => i.code)).toEqual(["CAPTURE_FAILED"]);
  });

  it("lets a shorthand capture carry an objective, which it can never prove", async () => {
    const workspace = fakeWorkspace();
    const source = path.join(workspace, "notes.txt");
    fs.writeFileSync(source, "notes");
    const { out } = await run(workspace, { objective: "{{ 'Notes' }} exist", file: { path: source } });
    expect(out).toMatchObject({ status: "inconclusive", objective: "Notes exist", steps: null, assertions: null, console: null });
  });

  it("raises OBJECTIVE_FAILED when a shorthand capture with an objective records a failure", async () => {
    const workspace = fakeWorkspace({ status: { "http://app/": 500 } });
    const { out, issues } = await run(workspace, {
      objective: OBJECTIVE,
      video: { url: "http://app/", duration: "1ms" },
    });
    expect(out.status).toBe("failed");
    expect(issues.map((i) => i.code)).toEqual(["OBJECTIVE_FAILED"]);
  });
});

describe("demo steps: cancelling", () => {
  it("stops the flow, closes the browser and keeps nothing", async () => {
    const workspace = fakeWorkspace({ hangLongWaits: true });
    const controller = new AbortController();
    const issues: Array<Record<string, unknown>> = [];
    const running = run(workspace, flow([{ screenshot: "before" }, { wait: "1m" }]), { signal: controller.signal, issues });
    await vi.waitFor(() => expect(logOf(workspace)).toContain("hang"));
    controller.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow("cancelled");
    expect(logOf(workspace)).toContain("browser.close");
    expect(filesIn(workspace)).toEqual([]);
    expect(issues).toEqual([]);
    expect(readDemoManifest(workspace, THREAD)).toEqual([]);
  }, 15_000);
});

describe("demo steps: schema", () => {
  const web = { web: { url: "http://app/" } };
  const parse = (value: unknown) => DemoWithSchema.safeParse(value);

  it("accepts a flow, and steps count as a mode of their own", () => {
    expect(parse({ target: web, steps: [{ click: "#a" }] }).success).toBe(true);
    expect(parse({ target: web, steps: [{ click: "#a" }], screenshot: { url: "http://app/" } }).success).toBe(false);
  });

  it("needs steps and target together, and expect only with steps", () => {
    expect(parse({ steps: [{ click: "#a" }] }).success).toBe(false);
    expect(parse({ target: web }).success).toBe(false);
    expect(parse({ screenshot: { url: "http://app/" }, expect: { noConsoleErrors: true } }).success).toBe(false);
    expect(parse({ target: web, steps: [] }).success).toBe(false);
  });

  it("takes exactly one verb per step, and one check per expect", () => {
    const good = (step: unknown) => parse({ target: web, steps: [step] }).success;
    expect(good({ click: "#a", press: "Enter" })).toBe(false);
    expect(good({ evaluate: "alert(1)" })).toBe(false);
    expect(good({ expect: { text: "a", visible: "#b" } })).toBe(false);
    for (const step of [
      { goto: "http://app/" },
      { click: "#a" },
      { fill: { selector: "#a", value: "" } },
      { press: "Enter" },
      { wait: "1s" },
      { screenshot: "name" },
      { expect: { text: "a" } },
      { expect: { visible: "#a" } },
      { expect: { url: "**/a" } },
      { expect: { hidden: "#a" } },
    ]) {
      expect(good(step), JSON.stringify(step)).toBe(true);
    }
  });

  it("keeps the objective allowed on a shorthand capture", () => {
    expect(parse({ objective: "x", screenshot: { url: "http://app/" } }).success).toBe(true);
  });
});

describe("demo steps: agent tools", () => {
  const graph = (proving: Record<string, unknown>, tools: unknown[] = [{ node: "prove" }]) =>
    ({
      metadata: { name: "g" },
      state: { channels: {} },
      nodes: [
        { id: "ask", type: "agent", with: { prompt: "x", tools } },
        { id: "prove", type: "demo", with: proving },
      ],
      edges: [
        { from: "START", to: "ask" },
        { from: "ask", to: "END" },
      ],
    }) as unknown as GraphSpec;

  it("refuses a demo node with an objective or steps as a tool", async () => {
    for (const proving of [
      { objective: "x", screenshot: { url: "http://app/" } },
      { target: { web: { url: "http://app/" } }, steps: [{ click: "#a" }] },
    ]) {
      expect(demoToolExposureDiagnostics(graph(proving))[0]).toMatchObject({ severity: "error", code: "DEMO_OBJECTIVE_AS_TOOL" });
      await expect(compileGraph(graph(proving), {})).rejects.toThrow(/can't be an agent tool/);
    }
  });

  it("also looks at an agent inside a map", () => {
    const spec = graph({ objective: "x", screenshot: { url: "http://app/" } });
    (spec.nodes[0] as unknown as Record<string, unknown>) = {
      id: "ask",
      type: "map",
      with: { over: "{{ state.items }}", node: { type: "agent", with: { prompt: "x", tools: [{ node: "prove" }] } } },
    };
    expect(demoToolExposureDiagnostics(spec).map((d) => d.path)).toEqual(["nodes.ask.with.node.with.tools"]);
  });

  it("still allows a plain capture as a tool", () => {
    expect(demoToolExposureDiagnostics(graph({ screenshot: { url: "http://app/" } }))).toEqual([]);
  });
});
