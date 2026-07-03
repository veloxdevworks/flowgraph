import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { stdin, stdout } from "node:process";
import type { McpServerDefs } from "@veloxdevworks/flowgraph-mcp";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import type { CompileOptions, McpHub } from "@veloxdevworks/flowgraph-core";
import { lazyOptionalImport } from "./optional-deps.js";

const loadMcp = lazyOptionalImport<typeof import("@veloxdevworks/flowgraph-mcp")>(
  "@veloxdevworks/flowgraph-mcp",
  "Install it: pnpm add @veloxdevworks/flowgraph-mcp",
);

function buildRenderScope(spec: GraphSpec): Record<string, unknown> {
  const secret = new Proxy({} as Record<string, string>, {
    get(_t, prop) {
      const v = process.env[String(prop)];
      return v ?? "";
    },
  });
  return {
    config: spec.config ?? {},
    vars: spec.config?.vars ?? {},
    secret,
  };
}

function renderString(template: string, scope: Record<string, unknown>): string {
  return String(renderDeep(template, scope));
}

/** Interpolate {{ secret.* }} / {{ config.vars.* }} in server connection fields. */
export function renderMcpServerDefs(spec: GraphSpec): McpServerDefs {
  const raw = spec.mcpServers;
  if (!raw) return {};
  const scope = buildRenderScope(spec);
  const out: McpServerDefs = {};

  for (const [name, def] of Object.entries(raw)) {
    if (def.transport === "stdio") {
      const entry: McpServerDefs[string] = {
        transport: "stdio",
        command: renderString(def.command, scope),
      };
      if (def.args) entry.args = def.args.map((a) => renderString(a, scope));
      if (def.env) {
        entry.env = Object.fromEntries(
          Object.entries(def.env).map(([k, v]) => [k, renderString(v, scope)]),
        );
      }
      if (def.auth) entry.auth = def.auth;
      out[name] = entry;
    } else {
      const entry: McpServerDefs[string] = {
        transport: "http",
        url: renderString(def.url, scope),
      };
      if (def.headers) {
        entry.headers = Object.fromEntries(
          Object.entries(def.headers).map(([k, v]) => [k, renderString(v, scope)]),
        );
      }
      if (def.auth) {
        const auth = { ...def.auth };
        if (auth.clientSecret) {
          auth.clientSecret = renderString(auth.clientSecret, scope);
        }
        if (auth.clientId) {
          auth.clientId = renderString(auth.clientId, scope);
        }
        if (auth.redirectUri) {
          auth.redirectUri = renderString(auth.redirectUri, scope);
        }
        entry.auth = auth;
      }
      out[name] = entry;
    }
  }
  return out;
}

function clientSecretsFromDefs(defs: McpServerDefs): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.transport === "http" && def.auth?.type === "oauth2" && def.auth.clientSecret) {
      out[name] = def.auth.clientSecret;
    }
  }
  return out;
}

export interface McpHubBuildOptions {
  cwd: string;
  interactiveOAuth?: boolean;
  onOAuthRedirect?: (url: URL) => void;
}

export interface McpHubRunOptions {
  json?: boolean | undefined;
  /** Disable browser OAuth prompt on first MCP connect (fail if tokens missing). */
  noMcpOauth?: boolean | undefined;
}

/** Enable interactive OAuth on first MCP tool/resource connect (TTY runs only). */
export function resolveInteractiveMcpOAuth(opts: McpHubRunOptions): boolean {
  if (opts.noMcpOauth || opts.json) return false;
  return stdin.isTTY && stdout.isTTY;
}

/** Hub options for `run` / `resume` / `mcp tools` — prompts OAuth on first connect when interactive. */
export async function mcpHubForRun(
  spec: GraphSpec,
  cwd: string,
  opts: McpHubRunOptions = {},
  onMessage?: (msg: string) => void,
): Promise<Pick<CompileOptions, "mcp">> {
  const interactive = resolveInteractiveMcpOAuth(opts);
  const extra: Omit<McpHubBuildOptions, "cwd"> = { interactiveOAuth: interactive };
  if (interactive) {
    extra.onOAuthRedirect = (url) => {
      onMessage?.(`MCP OAuth required — complete authorization in your browser:\n  ${url.toString()}`);
    };
  }
  return mcpHubOption(spec, cwd, extra);
}

/**
 * Build an MCP hub from the graph's mcpServers block (for compileGraph).
 */
export async function mcpHubOption(
  spec: GraphSpec,
  cwd: string,
  extra: Omit<McpHubBuildOptions, "cwd"> = {},
): Promise<Pick<CompileOptions, "mcp">> {
  if (!spec.mcpServers || Object.keys(spec.mcpServers).length === 0) return {};
  const mcp = await loadMcp();
  const defs = renderMcpServerDefs(spec);
  const hubOpts: Parameters<typeof mcp.createMcpHub>[1] = {
    cwd,
    oauthStoreDir: mcp.defaultOAuthStoreDir(cwd),
    clientSecrets: clientSecretsFromDefs(defs),
  };
  if (extra.interactiveOAuth !== undefined) hubOpts.interactiveOAuth = extra.interactiveOAuth;
  if (extra.onOAuthRedirect) hubOpts.onOAuthRedirect = extra.onOAuthRedirect;
  return { mcp: mcp.createMcpHub(defs, hubOpts) };
}

/** Close an MCP hub if present (safe no-op). */
export async function closeMcpHub(hub: McpHub | undefined): Promise<void> {
  if (hub) await hub.close();
}

export function resolveMcpServer(
  spec: GraphSpec,
  serverName: string,
  _cwd: string,
): { name: string; def: McpServerDefs[string]; defs: McpServerDefs } {
  const defs = renderMcpServerDefs(spec);
  const def = defs[serverName];
  if (!def) {
    throw new Error(
      `Unknown MCP server "${serverName}". Available: ${Object.keys(defs).join(", ") || "(none)"}.`,
    );
  }
  return { name: serverName, def, defs };
}

export async function loginMcpServer(
  spec: GraphSpec,
  serverName: string,
  cwd: string,
  opts: { openBrowser?: boolean; onRedirect?: (url: URL) => void } = {},
) {
  const mcp = await loadMcp();
  const { def } = resolveMcpServer(spec, serverName, cwd);
  if (def.transport !== "http") {
    throw new Error(`MCP server "${serverName}" uses stdio transport; OAuth applies to HTTP servers only.`);
  }
  if (!mcp.isOAuth2Auth(def.auth)) {
    throw new Error(
      `MCP server "${serverName}" is not configured for OAuth. Set auth.type: oauth2 in mcpServers.`,
    );
  }

  const storeDir = mcp.defaultOAuthStoreDir(cwd);
  const clientSecrets = clientSecretsFromDefs(renderMcpServerDefs(spec));

  const loginOpts: Parameters<typeof mcp.runMcpOAuthLogin>[0] = {
    serverName,
    serverUrl: def.url,
    auth: def.auth,
    storeDir,
  };
  if (opts.openBrowser !== undefined) loginOpts.openBrowser = opts.openBrowser;
  if (opts.onRedirect) loginOpts.onRedirect = opts.onRedirect;
  const secret = clientSecrets[serverName];
  if (secret) loginOpts.clientSecret = secret;
  return mcp.runMcpOAuthLogin(loginOpts);
}

export async function mcpOAuthStatus(
  spec: GraphSpec,
  cwd: string,
  serverName?: string,
): Promise<Array<{ server: string; connected: boolean; storePath: string; hasRefreshToken: boolean }>> {
  const mcp = await loadMcp();
  const defs = renderMcpServerDefs(spec);
  const storeDir = mcp.defaultOAuthStoreDir(cwd);
  const names = serverName ? [serverName] : Object.keys(defs);

  const rows: Array<{
    server: string;
    connected: boolean;
    storePath: string;
    hasRefreshToken: boolean;
  }> = [];

  for (const name of names) {
    const def = defs[name];
    if (!def || def.transport !== "http" || !mcp.isOAuth2Auth(def.auth)) continue;
    const key = def.auth.tokenStoreKey ?? name;
    const storePath = mcp.oauthStorePath(storeDir, key);
    const session = await mcp.readOAuthSession(storeDir, key);
    rows.push({
      server: name,
      connected: Boolean(session?.tokens?.access_token),
      storePath,
      hasRefreshToken: Boolean(session?.tokens?.refresh_token),
    });
  }
  return rows;
}

export async function logoutMcpServer(spec: GraphSpec, serverName: string, cwd: string): Promise<void> {
  const mcp = await loadMcp();
  const { def } = resolveMcpServer(spec, serverName, cwd);
  if (def.transport !== "http" || !mcp.isOAuth2Auth(def.auth)) {
    throw new Error(`MCP server "${serverName}" has no OAuth session to clear.`);
  }
  const storeDir = mcp.defaultOAuthStoreDir(cwd);
  const key = def.auth.tokenStoreKey ?? serverName;
  await mcp.createFileOAuthTokenStore(mcp.oauthStorePath(storeDir, key)).clear("all");
}
