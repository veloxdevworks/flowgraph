import { Command } from "commander";
import pc from "picocolors";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadGraph, validateSpec, compileGraph, consoleSink, loadGraphImports, preflightGraphSkills, preflightGraphAgents, waitForWebhookResume, resolveAndValidateInput, isInputValidationError, type RunOptions, type ResumeOptions, type InterruptInfo, type RunResult } from "@veloxdevworks/flowgraph-core";
import { isError, generateJsonSchema } from "@veloxdevworks/flowgraph-spec";
import { buildSkillsCommand } from "./skills-command.js";
import { checkpointerOption, promptResolver, serializePendingInterrupts } from "./interrupts.js";
import { mcpHubForRun, closeMcpHub, loginMcpServer, mcpOAuthStatus, logoutMcpServer } from "./mcp.js";
import { buildProviders } from "./providers.js";
import { registerLocalTools } from "./local-tools.js";
import { loadDotenvFromCwd } from "./env.js";
import { templateFor, listTemplates } from "./templates.js";
import { migrateSpec } from "./migrate.js";
import { printDiagnostics, printBanner, printSuccess, printError, printInfo, printWarning, formatDuration } from "./ui.js";

function webhookUrlFromInterrupts(interrupts: InterruptInfo[] | undefined): string | undefined {
  for (const it of interrupts ?? []) {
    const payload = it.payload as { data?: { webhookUrl?: string; mode?: string } } | undefined;
    if (payload?.data?.mode === "webhook" && typeof payload.data.webhookUrl === "string") {
      return payload.data.webhookUrl;
    }
  }
  return undefined;
}

function reportInterrupts(interrupts: InterruptInfo[] | undefined, threadId: string | undefined): void {
  const webhookUrl = webhookUrlFromInterrupts(interrupts);
  if (webhookUrl) {
    printWarning("Run interrupted — waiting for inbound webhook.");
    printInfo(`  POST ${webhookUrl}`);
    printInfo("  (GET the same URL to verify the listener is up)");
    return;
  }
  printWarning("Run interrupted (awaiting human input).");
  for (const it of interrupts ?? []) {
    printInfo(`  • ${it.reason ?? it.id}`);
  }
  if (threadId) {
    printInfo(`Resume with: flowgraph resume <graph> --thread ${threadId} --resume '{"approved":true}'`);
  } else {
    printInfo("Tip: pass --thread <id> so the run is resumable.");
  }
}

/**
 * When a webhook wait interrupt is active, keep the process alive until the
 * HTTP listener resumes (or the user hits Ctrl-C). Returns the post-resume
 * status when available.
 */
async function awaitWebhookIfNeeded(result: RunResult): Promise<RunResult> {
  if (result.status !== "interrupted") return result;
  const webhookUrl = webhookUrlFromInterrupts(result.interrupts);
  if (!webhookUrl || !result.threadId) return result;

  const waiter = waitForWebhookResume(result.threadId);
  if (!waiter) return result;

  printInfo("Listening for webhook… (Ctrl-C to exit)");
  const done = await new Promise<{ status: string; error?: string }>((resolve) => {
    const onSig = () => {
      printWarning("Interrupted by user.");
      resolve({ status: "cancelled" });
    };
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    void waiter.then((r) => {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      resolve(r);
    });
  });

  if (done.status === "completed") {
    printSuccess("Webhook received — run completed.");
    return { ...result, status: "completed" };
  }
  if (done.status === "cancelled") {
    return result;
  }
  if (done.status === "error") {
    printError(`Webhook resume failed: ${done.error ?? "unknown error"}`);
    return { ...result, status: "error", error: new Error(done.error ?? "resume failed") };
  }
  // Another interrupt after resume, etc.
  return { ...result, status: done.status as RunResult["status"] };
}

const program = new Command()
  .name("flowgraph")
  .description("Declarative orchestration layer on top of LangGraph.js")
  .version("0.1.0");

program.addCommand(buildSkillsCommand());

// ---------------------------------------------------------------------------
// tui — interactive terminal UI (optional @veloxdevworks/flowgraph-tui package)
// ---------------------------------------------------------------------------
program
  .command("tui [graph]")
  .description("Launch the interactive TUI")
  .option("--cwd <dir>", "Working directory")
  .action(async (graphPath: string | undefined, opts: { cwd?: string }) => {
    try {
      const { launchTui } = await import("@veloxdevworks/flowgraph-tui");
      await launchTui({
        ...(graphPath ? { graphPath } : {}),
        cwd: opts.cwd ?? process.cwd(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
        printError("TUI is not installed. Install it: pnpm add @veloxdevworks/flowgraph-tui");
      } else {
        printError(msg);
      }
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
program
  .command("validate <graph>")
  .description("Validate a graph spec (offline, no side effects)")
  .option("--preflight", "Also check skill env deps")
  .option("--strict", "Treat warnings as errors")
  .option("--format <format>", "Output format: pretty|json", "pretty")
  .action(async (graphPath: string, opts: { preflight?: boolean; strict?: boolean; format?: string }) => {
    const cwd = path.dirname(path.resolve(process.cwd(), graphPath));
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    const allDiags = [...loadDiags];

    if (spec) {
      const imported = await loadGraphImports(spec, { cwd });
      allDiags.push(...validateSpec(spec));

      if (opts.preflight) {
        const pf = await preflightGraphSkills(spec, {
          cwd,
          skillAliases: imported.skillAliases,
        });
        allDiags.push(...pf.diagnostics);
        if (opts.format !== "json" && pf.report) {
          console.log(pf.report);
        }
        const agentPf = await preflightGraphAgents(spec, {
          cwd,
          agentAliases: imported.agentAliases,
        });
        allDiags.push(...agentPf.diagnostics);
      }
    }

    const strict = opts.strict ?? false;
    const hasError = allDiags.some((d) => isError(d) || (strict && d.severity === "warning"));

    if (opts.format === "json") {
      console.log(JSON.stringify(allDiags, null, 2));
    } else {
      if (allDiags.length === 0) {
        printSuccess(`${graphPath} is valid`);
      } else if (!hasError) {
        printSuccess(`${graphPath} is valid`);
        printDiagnostics(allDiags.filter((d) => d.severity === "warning"), graphPath);
      } else {
        console.log(pc.bold(`\nValidating ${graphPath}`));
        printDiagnostics(allDiags, graphPath);
      }
    }

    process.exit(hasError ? 2 : 0);
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
program
  .command("run <graph>")
  .description("Run a graph")
  .option("--input <kv...>", "Initial state values (key=value or key=@file.json)")
  .option("--thread <id>", "Thread ID for checkpointing/resume")
  .option("--stream", "Stream events to stdout")
  .option("--json", "Emit events as JSONL on stdout")
  .option("--on-interrupt <policy>", "HITL policy: prompt|fail|approve|webhook", "fail")
  .option("--no-mcp-oauth", "Do not prompt for MCP OAuth on connect; fail if tokens are missing")
  .option("--cwd <dir>", "Working directory")
  .action(async (
    graphPath: string,
    opts: {
      input?: string[];
      thread?: string;
      stream?: boolean;
      json?: boolean;
      onInterrupt?: "prompt" | "fail" | "approve" | "webhook";
      noMcpOauth?: boolean;
      cwd?: string;
    },
  ) => {
    const cwd = opts.cwd ?? process.cwd();
    loadDotenvFromCwd(cwd);

    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }

    const graphDir = path.dirname(path.resolve(cwd, graphPath));

    const imported = await loadGraphImports(spec, { cwd: graphDir });

    const lintDiags = validateSpec(spec);
    const fatalDiags = [...loadDiags, ...lintDiags].filter(isError);
    if (fatalDiags.length > 0) {
      printError("Graph has errors:");
      printDiagnostics(fatalDiags, graphPath);
      process.exit(2);
    }

    const preflight = await preflightGraphSkills(spec, {
      cwd: graphDir,
      skillAliases: imported.skillAliases,
    });
    if (!preflight.ok) {
      printError("Skill preflight failed — fix environment before running:");
      if (preflight.report) console.log(preflight.report);
      else printDiagnostics(preflight.diagnostics, graphPath);
      process.exit(2);
    }
    const agentPreflight = await preflightGraphAgents(spec, {
      cwd: graphDir,
      agentAliases: imported.agentAliases,
    });
    if (!agentPreflight.ok) {
      printError("Agent preflight failed — fix agent definitions before running:");
      printDiagnostics(agentPreflight.diagnostics, graphPath);
      process.exit(2);
    }

    // Parse --input flags and validate against declared `inputs` schema (fail fast)
    let inputState: Record<string, unknown>;
    try {
      const rawInput = await parseInputFlags(opts.input ?? [], cwd);
      // Merge graph-default `input` under CLI overrides, then apply schema defaults/validation
      inputState = resolveAndValidateInput(spec.inputs, { ...(spec.input ?? {}), ...rawInput });
    } catch (err) {
      if (isInputValidationError(err)) {
        printError(err.message);
        printInfo("Pass values with --input key=value (or key=@file.json).");
        process.exit(1);
      }
      throw err;
    }

    // Build sinks
    const sinks = opts.json
      ? [consoleSink({ format: "json" })]
      : opts.stream
        ? [consoleSink({ format: "pretty" })]
        : [];

    const mcpOpt = await mcpHubForRun(
      spec,
      cwd,
      { json: opts.json, noMcpOauth: opts.noMcpOauth },
      (msg) => printInfo(msg),
    );
    const providers = await buildProviders(spec, cwd);
    const localTools = await registerLocalTools(spec, cwd);
    for (const w of localTools.warnings) printWarning(w);
    const compiled = await compileGraph(spec, {
      cwd,
      graphPath,
      sinks,
      providers,
      ...(await checkpointerOption(spec)),
      ...mcpOpt,
    });

    if (!opts.json && !opts.stream) {
      printBanner(`Running ${spec.metadata.name}`);
    }

    const policy = opts.onInterrupt ?? "fail";
    const runOpts: RunOptions = { input: inputState, onInterrupt: policy };
    if (opts.thread !== undefined) runOpts.threadId = opts.thread;
    if (policy === "prompt") runOpts.resolveInterrupt = promptResolver;
    let result;
    try {
      result = await compiled.run(runOpts);

      if (!opts.json) {
        if (result.status === "completed") {
          printSuccess(`Completed in ${formatDuration(result.durationMs)}`);
          printInfo(`Run ID: ${result.runId}`);
        } else if (result.status === "interrupted") {
          reportInterrupts(result.interrupts, result.threadId);
          result = await awaitWebhookIfNeeded(result);
          if (result.status === "completed") {
            printSuccess("Completed after webhook resume.");
            printInfo(`Run ID: ${result.runId}`);
          } else if (result.status === "error") {
            process.exit(1);
          } else {
            process.exit(3);
          }
        } else if (result.status === "error") {
          printError(`Failed: ${result.error?.message ?? "unknown error"}`);
          process.exit(1);
        }
      } else if (result.status === "interrupted") {
        result = await awaitWebhookIfNeeded(result);
        if (result.status === "error") process.exit(1);
        if (result.status !== "completed") process.exit(3);
      } else if (result.status === "error") {
        process.exit(1);
      }
    } finally {
      await closeMcpHub(mcpOpt.mcp);
    }
  });

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------
program
  .command("resume <graph>")
  .description("Resume an interrupted run on a given thread")
  .requiredOption("--thread <id>", "Thread ID to resume")
  .option("--list", "List pending interrupts for the thread and exit")
  .option("--resume <json>", "Resume value passed to the interrupt (JSON)")
  .option("--stream", "Stream events to stdout")
  .option("--json", "Emit events as JSONL on stdout")
  .option("--on-interrupt <policy>", "HITL policy if it interrupts again: prompt|fail|approve|webhook", "fail")
  .option("--no-mcp-oauth", "Do not prompt for MCP OAuth on connect; fail if tokens are missing")
  .option("--cwd <dir>", "Working directory")
  .action(async (
    graphPath: string,
    opts: {
      thread: string;
      list?: boolean;
      resume?: string;
      stream?: boolean;
      json?: boolean;
      onInterrupt?: "prompt" | "fail" | "approve" | "webhook";
      noMcpOauth?: boolean;
      cwd?: string;
    },
  ) => {
    const cwd = opts.cwd ?? process.cwd();
    loadDotenvFromCwd(cwd);
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }

    const graphDir = path.dirname(path.resolve(cwd, graphPath));
    const imported = await loadGraphImports(spec, { cwd: graphDir });
    const preflight = await preflightGraphSkills(spec, {
      cwd: graphDir,
      skillAliases: imported.skillAliases,
    });
    if (!preflight.ok) {
      printError("Skill preflight failed:");
      if (preflight.report) console.log(preflight.report);
      else printDiagnostics(preflight.diagnostics, graphPath);
      process.exit(2);
    }
    const agentPreflight = await preflightGraphAgents(spec, {
      cwd: graphDir,
      agentAliases: imported.agentAliases,
    });
    if (!agentPreflight.ok) {
      printError("Agent preflight failed:");
      printDiagnostics(agentPreflight.diagnostics, graphPath);
      process.exit(2);
    }

    let resumeValue: unknown = { approved: true };
    if (opts.resume !== undefined) {
      try { resumeValue = JSON.parse(opts.resume) as unknown; }
      catch { resumeValue = opts.resume; }
    }

    const sinks = opts.json
      ? [consoleSink({ format: "json" })]
      : opts.stream
        ? [consoleSink({ format: "pretty" })]
        : [];

    const mcpOpt = await mcpHubForRun(
      spec,
      cwd,
      { json: opts.json, noMcpOauth: opts.noMcpOauth },
      (msg) => printInfo(msg),
    );
    const providers = await buildProviders(spec, cwd);
    const localTools = await registerLocalTools(spec, cwd);
    for (const w of localTools.warnings) printWarning(w);
    const compiled = await compileGraph(spec, {
      cwd,
      graphPath,
      sinks,
      providers,
      ...(await checkpointerOption(spec)),
      ...mcpOpt,
    });

    const snap = await compiled.getState(opts.thread);
    if (!snap) {
      printError(`No checkpoint found for thread "${opts.thread}". Is the checkpoint backend durable (runtime.checkpoint.backend: sqlite)?`);
      process.exit(2);
    }

    if (opts.list) {
      const listed = serializePendingInterrupts(opts.thread, snap.interrupts);
      if (opts.json) {
        console.log(JSON.stringify(listed, null, 2));
      } else {
        if (listed.interrupts.length === 0) {
          printInfo(`No pending interrupts for thread "${opts.thread}".`);
          if (snap.next.length > 0) {
            printInfo(`Next nodes: ${snap.next.join(", ")}`);
          }
        } else {
          printInfo(`Pending interrupts for thread "${opts.thread}":`);
          for (const it of listed.interrupts) {
            printInfo(`  • [${String(it["kind"])}] ${String(it["reason"] ?? it["id"])}`);
            if (Array.isArray(it["choices"]) && it["choices"].length > 0) {
              for (const [i, c] of (it["choices"] as string[]).entries()) {
                printInfo(`      ${i + 1}. ${c}`);
              }
            }
          }
        }
      }
      await closeMcpHub(mcpOpt.mcp);
      process.exit(0);
    }

    if (!opts.json && !opts.stream) printBanner(`Resuming ${spec.metadata.name} (thread ${opts.thread})`);

    const policy = opts.onInterrupt ?? "fail";
    const resumeOpts: ResumeOptions = { threadId: opts.thread, resume: resumeValue, onInterrupt: policy };
    if (policy === "prompt") resumeOpts.resolveInterrupt = promptResolver;
    let result;
    try {
      result = await compiled.resume(resumeOpts);

      if (!opts.json) {
        if (result.status === "completed") {
          printSuccess(`Completed in ${formatDuration(result.durationMs)}`);
        } else if (result.status === "interrupted") {
          reportInterrupts(result.interrupts, result.threadId);
          result = await awaitWebhookIfNeeded(result);
          if (result.status === "completed") {
            printSuccess("Completed after webhook resume.");
          } else if (result.status === "error") {
            process.exit(1);
          } else {
            process.exit(3);
          }
        } else if (result.status === "error") {
          printError(`Failed: ${result.error?.message ?? "unknown error"}`);
          process.exit(1);
        }
      } else if (result.status === "interrupted") {
        result = await awaitWebhookIfNeeded(result);
        if (result.status === "error") process.exit(1);
        if (result.status !== "completed") process.exit(3);
      } else if (result.status !== "completed") {
        process.exit(result.status === "interrupted" ? 3 : 1);
      }
    } finally {
      await closeMcpHub(mcpOpt.mcp);
    }
  });

// ---------------------------------------------------------------------------
// mcp — inspect MCP servers declared in a graph
// ---------------------------------------------------------------------------
const mcpCmd = program
  .command("mcp")
  .description("Inspect MCP servers declared in a graph spec");

mcpCmd
  .command("tools <graph>")
  .description("List tools exposed by each mcpServers entry")
  .option("--cwd <dir>", "Working directory")
  .option("--no-mcp-oauth", "Do not prompt for MCP OAuth on connect; fail if tokens are missing")
  .action(async (graphPath: string, opts: { cwd?: string; noMcpOauth?: boolean }) => {
    const cwd = opts.cwd ?? process.cwd();
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }
    if (!spec.mcpServers || Object.keys(spec.mcpServers).length === 0) {
      printInfo("No mcpServers declared in this graph.");
      return;
    }
    const mcpOpt = await mcpHubForRun(
      spec,
      cwd,
      { noMcpOauth: opts.noMcpOauth },
      (msg) => printInfo(msg),
    );
    if (!mcpOpt.mcp) {
      printError("Could not create MCP hub.");
      process.exit(2);
    }
    try {
      for (const server of Object.keys(spec.mcpServers)) {
        console.log(pc.bold(`\n${server}`));
        const tools = await mcpOpt.mcp.listTools(server);
        if (tools.length === 0) {
          console.log("  (no tools)");
          continue;
        }
        for (const t of tools) {
          const desc = t.description ? ` — ${t.description}` : "";
          console.log(`  ${pc.cyan(t.name)}${desc}`);
        }
      }
    } finally {
      await closeMcpHub(mcpOpt.mcp);
    }
  });

const mcpAuthCmd = mcpCmd.command("auth").description("OAuth 2.1 for remote MCP servers");

mcpAuthCmd
  .command("login <graph> <server>")
  .description("Complete OAuth 2.1 browser consent for a remote MCP server")
  .option("--cwd <dir>", "Working directory")
  .option("--no-open", "Print the authorization URL instead of opening a browser")
  .action(async (
    graphPath: string,
    serverName: string,
    opts: { cwd?: string; open?: boolean },
  ) => {
    const cwd = opts.cwd ?? process.cwd();
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }

    try {
      printBanner(`OAuth login: ${serverName}`);
      const result = await loginMcpServer(spec, serverName, cwd, {
        openBrowser: opts.open !== false,
        onRedirect: (url) => printInfo(`Authorization URL: ${url.toString()}`),
      });
      printSuccess(`Connected to "${result.serverName}"`);
      printInfo(`Tokens saved: ${result.storePath}`);
      if (result.hasRefreshToken) printInfo("Refresh token stored — future runs will auto-refresh.");
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

mcpAuthCmd
  .command("status <graph> [server]")
  .description("Show OAuth token status for MCP servers in a graph")
  .option("--cwd <dir>", "Working directory")
  .action(async (graphPath: string, serverName: string | undefined, opts: { cwd?: string }) => {
    const cwd = opts.cwd ?? process.cwd();
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }

    const rows = await mcpOAuthStatus(spec, cwd, serverName);
    if (rows.length === 0) {
      printInfo("No OAuth-configured HTTP MCP servers in this graph.");
      return;
    }
    for (const row of rows) {
      const status = row.connected ? pc.green("connected") : pc.yellow("not connected");
      console.log(`${pc.bold(row.server)}: ${status}`);
      console.log(`  store: ${row.storePath}`);
      if (row.hasRefreshToken) console.log("  refresh token: yes");
    }
  });

mcpAuthCmd
  .command("logout <graph> <server>")
  .description("Clear stored OAuth tokens for an MCP server")
  .option("--cwd <dir>", "Working directory")
  .action(async (graphPath: string, serverName: string, opts: { cwd?: string }) => {
    const cwd = opts.cwd ?? process.cwd();
    const { spec, diagnostics: loadDiags } = await loadGraph(graphPath, { cwd });
    if (!spec) {
      printError("Failed to load graph:");
      printDiagnostics(loadDiags, graphPath);
      process.exit(2);
    }

    try {
      await logoutMcpServer(spec, serverName, cwd);
      printSuccess(`Cleared OAuth session for "${serverName}".`);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// graph (inspect)
// ---------------------------------------------------------------------------
program
  .command("graph <graphPath>")
  .description("Inspect a graph (topology)")
  .option("--format <format>", "Output format: ascii|mermaid|json", "ascii")
  .action(async (graphPath: string, opts: { format?: string }) => {
    const { spec, diagnostics } = await loadGraph(graphPath);
    if (!spec) { printDiagnostics(diagnostics, graphPath); process.exit(2); }

    if (opts.format === "json") {
      console.log(JSON.stringify({ metadata: spec.metadata, nodes: spec.nodes.map((n) => ({ id: n.id, type: n.type })), edges: spec.edges }, null, 2));
    } else if (opts.format === "mermaid") {
      console.log(toMermaid(spec));
    } else {
      console.log(toAscii(spec));
    }
  });

// ---------------------------------------------------------------------------
// schema — emit the Graph JSON Schema (for editor autocomplete / CI)
// ---------------------------------------------------------------------------
program
  .command("schema")
  .description("Print the flowgraph Graph JSON Schema (for editor autocomplete)")
  .option("--out <file>", "Write to a file instead of stdout")
  .action(async (opts: { out?: string }) => {
    const schema = generateJsonSchema();
    const json = JSON.stringify(schema, null, 2);
    if (opts.out) {
      const dest = path.resolve(process.cwd(), opts.out);
      await fs.writeFile(dest, json + "\n", "utf-8");
      printSuccess(`Wrote JSON Schema to ${opts.out}`);
      printInfo("Tip: add a header to your YAML for editor autocomplete:");
      printInfo(`  # yaml-language-server: $schema=${opts.out}`);
    } else {
      console.log(json);
    }
  });

// ---------------------------------------------------------------------------
// new / init — scaffold a starter graph from a template
// ---------------------------------------------------------------------------
const scaffold = async (
  name: string,
  opts: { template?: string; dir?: string },
): Promise<void> => {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    printError(`Graph name "${name}" must be kebab-case (e.g. my-graph).`);
    process.exit(2);
  }
  const templateName = opts.template ?? "hello";
  const result = templateFor(templateName, name);
  if (!result) {
    printError(`Unknown template "${templateName}". Available: ${listTemplates().join(", ")}.`);
    process.exit(2);
  }
  const dir = path.resolve(process.cwd(), opts.dir ?? ".");
  await fs.mkdir(dir, { recursive: true });

  const resolvedPaths = result.files.map((f) => path.join(dir, f.path));
  for (const dest of resolvedPaths) {
    try {
      await fs.access(dest);
      printError(`File already exists: ${dest}`);
      process.exit(1);
    } catch {
      /* does not exist — ok */
    }
  }

  for (const file of result.files) {
    const dest = path.join(dir, file.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content, { flag: "wx" });
  }

  const graphRel = path.relative(process.cwd(), path.join(dir, result.graphFile));
  printSuccess(`Created ${result.files.length} file(s) (template: ${templateName})`);
  for (const file of result.files) {
    printInfo(`  ${path.relative(process.cwd(), path.join(dir, file.path))}`);
  }
  printInfo(`Next: flowgraph validate ${graphRel}`);
  printInfo(`      flowgraph run ${graphRel} --stream --input 'name=World'`);
};

program
  .command("new <name>")
  .description("Scaffold a new graph from a template")
  .option("--template <t>", `Template: ${listTemplates().join("|")}`, "hello")
  .option("--dir <dir>", "Target directory", ".")
  .action(scaffold);

program
  .command("init <name>")
  .description("Alias for `new` — scaffold a new graph from a template")
  .option("--template <t>", `Template: ${listTemplates().join("|")}`, "hello")
  .option("--dir <dir>", "Target directory", ".")
  .action(scaffold);

// ---------------------------------------------------------------------------
// migrate — upgrade a graph spec toward the current apiVersion
// ---------------------------------------------------------------------------
program
  .command("migrate <graph>")
  .description("Migrate a graph spec toward the current apiVersion (flowgraph/v1)")
  .option("--write", "Write changes back to the file (otherwise dry-run)")
  .action(async (graphPath: string, opts: { write?: boolean }) => {
    const resolved = path.resolve(process.cwd(), graphPath);
    let raw: string;
    try { raw = await fs.readFile(resolved, "utf-8"); }
    catch { printError(`Cannot read ${graphPath}`); process.exit(2); }

    const { changed, output, notes } = migrateSpec(raw);
    for (const note of notes) printInfo(`  • ${note}`);
    if (!changed) {
      printSuccess(`${graphPath} is already up to date (flowgraph/v1).`);
      return;
    }
    if (opts.write) {
      await fs.writeFile(resolved, output, "utf-8");
      printSuccess(`Migrated ${graphPath} in place.`);
    } else {
      printWarning("Dry run — re-run with --write to apply. Proposed result:");
      console.log(output);
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function parseInputFlags(
  flags: string[],
  cwd: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq < 0) continue;
    const key = flag.slice(0, eq);
    const val = flag.slice(eq + 1);
    if (val.startsWith("@")) {
      const filePath = path.resolve(cwd, val.slice(1));
      const raw = await fs.readFile(filePath, "utf-8");
      result[key] = JSON.parse(raw) as unknown;
    } else {
      try { result[key] = JSON.parse(val) as unknown; }
      catch { result[key] = val; }
    }
  }
  return result;
}

function toMermaid(spec: import("@veloxdevworks/flowgraph-spec").GraphSpec): string {
  const lines = ["graph TD"];
  for (const edge of spec.edges) {
    const from = edge.from === "START" ? "START([START])" : edge.from;
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      for (const t of tos) {
        const to = t === "END" ? "END([END])" : t;
        lines.push(`  ${from} --> ${to}`);
      }
    } else if ("branch" in edge) {
      for (const b of edge.branch) {
        const to = b.to === "END" ? "END([END])" : b.to;
        const label = b.when ? `|${b.when}|` : b.default ? "|default|" : "";
        lines.push(`  ${from} --${label}--> ${to}`);
      }
    }
  }
  return lines.join("\n");
}

function toAscii(spec: import("@veloxdevworks/flowgraph-spec").GraphSpec): string {
  const lines: string[] = [];
  lines.push(pc.bold(`Graph: ${spec.metadata.name}`));
  lines.push("");
  lines.push(pc.dim("Nodes:"));
  for (const n of spec.nodes) {
    lines.push(`  ${pc.cyan(n.id)} [${n.type}]${n.name ? ` — ${n.name}` : ""}`);
  }
  lines.push("");
  lines.push(pc.dim("Edges:"));
  for (const edge of spec.edges) {
    if ("to" in edge) {
      const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
      for (const t of tos) lines.push(`  ${edge.from} → ${t}`);
    } else if ("branch" in edge) {
      for (const b of edge.branch) {
        lines.push(`  ${edge.from} → ${b.to}${b.when ? ` (when: ${b.when})` : b.default ? " (default)" : ""}`);
      }
    }
  }
  return lines.join("\n");
}

export { program };
