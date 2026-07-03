/**
 * Ambient types for the optional @veloxdevworks/flowgraph-mcp peer dependency.
 *
 * The CLI never imports this package's runtime code directly — it's loaded lazily via
 * lazyOptionalImport() so `flowgraph run`/`validate` work without it installed. This
 * shim lets the CLI typecheck without the package present in the workspace; it mirrors
 * the package's public surface (see @veloxdevworks/flowgraph-mcp's src/index.ts).
 */
declare module "@veloxdevworks/flowgraph-mcp" {
  import type { McpHub } from "@veloxdevworks/flowgraph-core";
  import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

  export type McpServerDefs = NonNullable<GraphSpec["mcpServers"]>;

  export interface CreateMcpHubOptions {
    cwd?: string;
    oauthStoreDir?: string;
    interactiveOAuth?: boolean;
    onOAuthRedirect?: (url: URL) => void;
    clientSecrets?: Record<string, string | undefined>;
  }

  export function createMcpHub(defs: McpServerDefs, opts?: CreateMcpHubOptions): McpHub;

  export interface McpOAuth2Config {
    type: "oauth2";
    redirectUri?: string | undefined;
    clientName?: string | undefined;
    scope?: string | undefined;
    callbackPort?: number | undefined;
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    clientMetadataUrl?: string | undefined;
    tokenStoreKey?: string | undefined;
  }

  export function isOAuth2Auth(auth: { type?: string } | undefined): auth is McpOAuth2Config;
  export function defaultRedirectUri(port?: number): string;

  export interface McpOAuthSession {
    tokens?: { access_token?: string; refresh_token?: string };
    clientInformation?: unknown;
    codeVerifier?: string;
    discoveryState?: unknown;
  }

  export interface McpOAuthTokenStore {
    load(): Promise<McpOAuthSession | undefined>;
    save(session: McpOAuthSession): Promise<void>;
    clear(scope?: "all" | "tokens" | "client" | "verifier" | "discovery"): Promise<void>;
  }

  export function createFileOAuthTokenStore(filePath: string): McpOAuthTokenStore;
  export function oauthStorePath(storeDir: string, key: string): string;
  export function readOAuthSession(storeDir: string, key: string): Promise<McpOAuthSession | undefined>;

  export interface McpOAuthLoginOptions {
    serverName: string;
    serverUrl: string;
    auth: McpOAuth2Config;
    storeDir: string;
    openBrowser?: boolean;
    onRedirect?: (url: URL) => void;
    clientSecret?: string | undefined;
  }

  export interface McpOAuthLoginResult {
    serverName: string;
    storePath: string;
    hasRefreshToken: boolean;
  }

  export function runMcpOAuthLogin(opts: McpOAuthLoginOptions): Promise<McpOAuthLoginResult>;
  export function defaultOAuthStoreDir(cwd: string): string;
}
