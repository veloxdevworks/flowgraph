import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { registerFunction } from "@veloxdevworks/flowgraph-core";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = __dirname;
const REPO_ROOT = path.resolve(__dirname, "../..");

function isDryRun(): boolean {
  return process.env["SELF_IMPROVE_DRY_RUN"] === "1";
}

function readText(filePath: string, maxChars = 12_000): string {
  if (!fs.existsSync(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[truncated]` : raw;
}

async function runShell(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 600_000,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (isDryRun()) {
    return { stdout: `[dry-run] ${cmd} ${args.join(" ")}`, stderr: "", code: 0 };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function githubToken(): string | undefined {
  const raw = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  return raw?.trim() || undefined;
}

function ghEnv(): Record<string, string> | undefined {
  const token = githubToken();
  if (!token) return undefined;
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

function parseGithubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const https = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?/i.exec(trimmed);
  if (https) return { owner: https[1]!, repo: https[2]! };
  return null;
}

async function createPrViaApi(
  owner: string,
  repo: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ prUrl: string; stderr: string }> {
  const token = githubToken();
  if (!token) {
    return { prUrl: "", stderr: "GITHUB_TOKEN/GH_TOKEN not set for REST fallback" };
  }
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "flowgraph-self-improve",
    },
    body: JSON.stringify({ title, head: branch, base: "main", body }),
  });
  const json = (await res.json()) as { html_url?: string; message?: string };
  if (!res.ok) {
    return { prUrl: "", stderr: json.message ?? `GitHub API ${res.status}` };
  }
  return { prUrl: json.html_url ?? "", stderr: "" };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "improvement";
}

registerFunction("checkPaused", () => {
  const pausedPath = path.join(AUTOMATION_ROOT, "PAUSED");
  const paused = fs.existsSync(pausedPath);
  return {
    paused,
    reason: paused ? readText(pausedPath, 500) || "PAUSED file present" : "",
  };
});

registerFunction("checkRuntime", async () => {
  if (isDryRun()) {
    return { ok: true, missing: [], warnings: [], notes: ["SELF_IMPROVE_DRY_RUN=1"] };
  }

  const missing: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!process.env["CURSOR_API_KEY"]?.trim()) {
    missing.push(
      "CURSOR_API_KEY — required for nested flowgraph Cursor provider calls; add as an Automation Secret (not ambient)",
    );
  }

  const pnpm = await runShell("pnpm", ["--version"], REPO_ROOT);
  if (pnpm.code !== 0) {
    warnings.push("pnpm not on PATH — commit .cursor/environment.json install step or enable corepack in the cloud environment");
  } else {
    notes.push(`pnpm ${pnpm.stdout.trim()}`);
  }

  const git = await runShell("git", ["--version"], REPO_ROOT);
  if (git.code !== 0) missing.push("git");
  else notes.push(git.stdout.trim());

  const gh = await runShell("gh", ["--version"], REPO_ROOT, 30_000, ghEnv());
  const hasGh = gh.code === 0;
  if (hasGh) {
    notes.push(gh.stdout.trim().split("\n")[0] ?? "gh available");
    const auth = await runShell("gh", ["auth", "status"], REPO_ROOT, 30_000, ghEnv());
    if (auth.code !== 0 && !githubToken()) {
      warnings.push(
        "gh not authenticated and no GITHUB_TOKEN/GH_TOKEN — openPr will fail unless git push + GitHub API token is set",
      );
    }
  } else if (!githubToken()) {
    warnings.push(
      "gh CLI missing and no GITHUB_TOKEN/GH_TOKEN — add a token Secret for PR creation and open-PR listing",
    );
  } else {
    notes.push("gh missing; will use GitHub REST API with GITHUB_TOKEN/GH_TOKEN for PR create");
  }

  return { ok: missing.length === 0, missing, warnings, notes };
});

registerFunction("loadContext", async () => {
  if (process.env["SELF_IMPROVE_TEST_SKIP"] === "1") {
    return {
      skip: true,
      skipReason: "test: open automation PR simulated",
      context: "",
    };
  }

  const stateMd = readText(path.join(AUTOMATION_ROOT, "STATE.md"), 8000);
  const statusMd = readText(path.join(REPO_ROOT, "docs/IMPLEMENTATION_STATUS.md"), 8000);
  const guardrails = readText(path.join(AUTOMATION_ROOT, "GUARDRAILS.md"), 8000);

  const log = await runShell("git", ["log", "--oneline", "-15"], REPO_ROOT);
  const openPr = await runShell(
    "gh",
    ["pr", "list", "--label", "automation", "--state", "open", "--json", "number,title,url"],
    REPO_ROOT,
    60_000,
    ghEnv(),
  );

  let skip = false;
  let skipReason = "";
  if (!isDryRun() && openPr.code === 0) {
    const trimmed = openPr.stdout.trim();
    if (trimmed && trimmed !== "[]") {
      skip = true;
      skipReason = `Open automation PR already exists: ${trimmed.slice(0, 300)}`;
    }
  }

  const context = [
    "# Guardrails",
    guardrails,
    "",
    "# Recent commits",
    log.stdout || log.stderr,
    "",
    "# Implementation status (excerpt)",
    statusMd,
    "",
    "# Prior automation runs",
    stateMd,
  ].join("\n");

  return { skip, skipReason, context };
});

registerFunction("runQualityGate", async (input) => {
  const { docsOnly = false } = input as { docsOnly?: boolean };
  if (process.env["SELF_IMPROVE_TEST_GATE_FAIL"] === "1") {
    return { passed: false, output: "test: simulated quality gate failure" };
  }

  const steps = docsOnly
    ? [["pnpm", ["format:check"]]]
    : [
        ["pnpm", ["build"]],
        ["pnpm", ["typecheck"]],
        ["pnpm", ["test"]],
        ["pnpm", ["lint"]],
      ];

  const chunks: string[] = [];
  for (const [cmd, args] of steps) {
    const result = await runShell(cmd, args as string[], REPO_ROOT);
    chunks.push(`$ ${cmd} ${(args as string[]).join(" ")}\n${result.stdout}\n${result.stderr}`.trim());
    if (result.code !== 0) {
      return { passed: false, output: chunks.join("\n\n---\n\n") };
    }
  }

  if (docsOnly) {
    chunks.push("Docs-only gate: site build not verified (flowgraph-app not checked out).");
  }

  return { passed: true, output: chunks.join("\n\n---\n\n") };
});

registerFunction("incrementAttempts", (input) => {
  const { attempts = 0, feedback = "", gateOutput = "" } = input as {
    attempts?: number;
    feedback?: string;
    gateOutput?: string;
  };
  const next = Number(attempts) + 1;
  const parts = [feedback, gateOutput].filter(Boolean);
  return {
    attempts: next,
    implementFeedback: parts.join("\n\n"),
  };
});

registerFunction("openPr", async (input) => {
  const { plan = {}, gate = {} } = input as {
    plan?: { title?: string; description?: string; docsOnly?: boolean };
    gate?: { output?: string };
  };
  const title = plan.title ?? "Automated improvement";
  const slug = slugify(title);
  const date = new Date().toISOString().slice(0, 10);
  const branch = `auto/self-improve-${date}-${slug}`;

  if (isDryRun() || process.env["SELF_IMPROVE_TEST_OPEN_PR"] === "1") {
    return {
      prUrl: "https://github.com/example/pull/1",
      branch,
      title,
    };
  }

  const status = await runShell("git", ["status", "--porcelain"], REPO_ROOT);
  if (!status.stdout.trim()) {
    return { prUrl: "", branch, title, error: "No changes to commit" };
  }

  await runShell("git", ["checkout", "-b", branch], REPO_ROOT);
  await runShell("git", ["add", "-A"], REPO_ROOT);

  const body = [
    "## Automated self-improvement",
    "",
    "_Opened by the automated self-improvement loop._",
    "",
    plan.description ?? "",
    "",
    "### Quality gate",
    "",
    "```",
    String(gate.output ?? "").slice(0, 4000),
    "```",
    "",
    plan.docsOnly ? "_Docs-only change: rendered site was not built in this runner._" : "",
  ]
    .filter(Boolean)
    .join("\n");

  const commitMsg = `${title}\n\nAutomated-by: self-improve-loop`;
  const commit = await runShell("git", ["commit", "-m", commitMsg], REPO_ROOT);
  if (commit.code !== 0) {
    return { prUrl: "", branch, title, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }

  const push = await runShell("git", ["push", "-u", "origin", branch], REPO_ROOT);
  if (push.code !== 0) {
    return {
      prUrl: "",
      branch,
      title,
      error: `git push failed (needs Cursor GitHub App write access or a token): ${push.stderr || push.stdout}`,
    };
  }

  const pr = await runShell(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--label", "automation", "--base", "main"],
    REPO_ROOT,
    120_000,
    ghEnv(),
  );

  if (pr.code === 0) {
    const prUrl = pr.stdout.trim().split("\n").pop() ?? "";
    return { prUrl, branch, title, stderr: pr.stderr };
  }

  const remote = await runShell("git", ["remote", "get-url", "origin"], REPO_ROOT);
  const parsed = parseGithubRepo(remote.stdout);
  if (parsed) {
    const viaApi = await createPrViaApi(parsed.owner, parsed.repo, branch, title, body);
    if (viaApi.prUrl) {
      return { prUrl: viaApi.prUrl, branch, title, stderr: `gh failed; used GitHub API. ${viaApi.stderr}` };
    }
    return {
      prUrl: "",
      branch,
      title,
      error: `gh pr create failed (${pr.stderr || pr.stdout}); API fallback failed (${viaApi.stderr})`,
    };
  }

  return {
    prUrl: "",
    branch,
    title,
    error: `gh pr create failed and could not parse origin remote: ${pr.stderr || pr.stdout}`,
  };
});

registerFunction("finalizeFailure", async (input) => {
  const { reason = "abandoned", branch = "" } = input as { reason?: string; branch?: string };
  if (branch && !isDryRun()) {
    await runShell("git", ["checkout", "main"], REPO_ROOT).catch(() => undefined);
    await runShell("git", ["branch", "-D", branch], REPO_ROOT).catch(() => undefined);
  }
  return { status: "abandoned", reason };
});

registerFunction("recordOutcome", (input) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const pausedCheck = (raw["pausedCheck"] ?? {}) as {
    paused?: boolean;
    reason?: string;
  };
  const ctx = (raw["ctx"] ?? {}) as { skip?: boolean; skipReason?: string };
  const plan = (raw["plan"] ?? {}) as {
    proceed?: boolean;
    reason?: string;
    title?: string;
    description?: string;
  };
  const pr = (raw["pr"] ?? {}) as {
    prUrl?: string;
    branch?: string;
    title?: string;
    error?: string;
  };
  const failure = (raw["failure"] ?? {}) as { status?: string; reason?: string };
  const runtime = (raw["runtime"] ?? {}) as {
    ok?: boolean;
    missing?: string[];
    warnings?: string[];
  };

  let status = "completed";
  let reason = "";
  if (pausedCheck.paused) {
    status = "paused";
    reason = String(pausedCheck.reason ?? "PAUSED");
  } else if (runtime.ok === false) {
    status = "runtime-failed";
    reason = [...(runtime.missing ?? []), ...(runtime.warnings ?? [])].join("; ").slice(0, 120);
  } else if (ctx.skip) {
    status = "skipped";
    reason = String(ctx.skipReason ?? "skip");
  } else if (plan.proceed === false) {
    status = "no-op";
    reason = String(plan.reason ?? "nothing to do");
  } else if (failure.status === "abandoned") {
    status = "abandoned";
    reason = String(failure.reason ?? "max attempts");
  } else if (pr.prUrl) {
    status = "pr-opened";
    reason = pr.title ?? "";
  } else if (pr.error) {
    status = "pr-failed";
    reason = String(pr.error);
  }

  const line = [
    `| ${new Date().toISOString()} | ${status} | ${plan.title ?? "—"} | ${reason.slice(0, 120)} | ${pr.prUrl || "—"} |`,
  ].join("");

  const statePath = path.join(AUTOMATION_ROOT, "STATE.md");
  if (!isDryRun()) {
    fs.appendFileSync(statePath, `${line}\n`, "utf8");
  }

  return { recorded: true, line, status, reason };
});

export default {};
