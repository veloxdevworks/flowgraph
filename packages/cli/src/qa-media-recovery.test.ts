import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
it("SIGKILL leaves a submission intent; resume cannot repay, and explicit recovery works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-media-kill-"));
  const bin = resolve(import.meta.dirname, "../dist/bin.js");
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 20000 });
  const core = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
  try {
    writeFileSync(
      join(dir, "vendor.mjs"),
      `import {registerMediaProvider} from ${JSON.stringify(core)}; import {appendFileSync,writeFileSync,existsSync} from 'node:fs'; registerMediaProvider({name:'test',vendor:'test',modalities:['image'],async start(){appendFileSync('calls','call\\n');writeFileSync('ready','yes');if(!existsSync('finish')) await new Promise(()=>{});return {id:'done',done:[],costUSD:0};}});export default [];`,
    );
    writeFileSync(
      join(dir, "flow.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "media-kill" },
        imports: [{ providers: "./vendor.mjs" }],
        nodes: [{ id: "img", type: "image", provider: "test", with: { prompt: "test" } }],
        edges: [
          { from: "START", to: "img" },
          { from: "img", to: "END" },
        ],
        runtime: { checkpoint: { backend: "sqlite", path: "cp.db" } },
      }),
    );
    const child = spawn(process.execPath, [bin, "run", "flow.yaml", "--thread", "kill", "--json"], {
      cwd: dir,
      stdio: "ignore",
    });
    const closed = new Promise<void>((done, fail) => {
      child.once("close", () => done());
      child.once("error", fail);
    });
    try {
      const until = Date.now() + 15000;
      while (!existsSync(join(dir, "ready")) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(join(dir, "ready"))).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    const claim = JSON.parse(
      cli("thread", "inspect", "flow.yaml", "--thread", "kill").stdout,
    ).claim;
    expect(
      cli(
        "thread",
        "release",
        "flow.yaml",
        "--thread",
        "kill",
        "--token",
        claim.token,
        "--owner-stopped",
      ).status,
    ).toBe(0);
    const resumed = cli("resume", "flow.yaml", "--thread", "kill", "--resume", "true", "--json");
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(1);
    expect(resumed.stdout + resumed.stderr).toContain("uncertain outcome");
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("call\n");
    const file = readdirSync(join(dir, ".flowgraph/jobs/kill"))[0]!,
      fingerprint = file.slice(4, -5);
    const args = [
      "flow.yaml",
      "--thread",
      "kill",
      "--node",
      "img",
      "--fingerprint",
      fingerprint,
      "--workspace",
      dir,
    ];
    const inspect = cli("media", "inspect", ...args);
    expect(inspect.status, inspect.stderr).toBe(0);
    const intent = JSON.parse(inspect.stdout);
    expect(
      cli("media", "resolve", ...args, "--submission", intent.submissionId, "--not-submitted")
        .status,
    ).toBe(1);
    expect(
      cli(
        "media",
        "resolve",
        ...args,
        "--submission",
        intent.submissionId,
        "--not-submitted",
        "--owner-stopped",
      ).status,
    ).toBe(0);
    const usage = JSON.parse(cli("usage", "inspect", "flow.yaml", "--thread", "kill").stdout).usage;
    expect(
      cli(
        "usage",
        "resolve",
        "flow.yaml",
        "--thread",
        "kill",
        "--receipt",
        Object.keys(usage.pending)[0]!,
        "--not-billed",
        "--owner-stopped",
      ).status,
    ).toBe(0);
    writeFileSync(join(dir, "finish"), "yes");
    const result = cli("resume", "flow.yaml", "--thread", "kill", "--resume", "true", "--json");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("call\ncall\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
