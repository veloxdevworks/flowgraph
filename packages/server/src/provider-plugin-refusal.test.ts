import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refusalOf } from "./errors.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import { RunService } from "./run-service.js";

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
    trust: { roles: [], teams: [] },
    defaultProject: "local",
  },
};

const untrusted: Principal = {
  id: "https://id.example.com|alice",
  subject: "alice",
  issuer: "https://id.example.com",
  org: "acme",
  project: "web",
  teams: [],
  roles: [],
  trusted: false,
  via: "oidc",
};
const trusted: Principal = { ...untrusted, trusted: true };

const withPlugin = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: plugin-provider }
providers:
  custom: { kind: plugin, plugin: not-installed }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?" } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
`;

const services: RunService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function service(): Promise<RunService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-plugin-refusal-"));
  dirs.push(dir);
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, auth: OIDC });
  await s.init();
  services.push(s);
  return s;
}

async function refusal(run: Promise<unknown>): Promise<{ status: number; code: string } | undefined> {
  try {
    await run;
  } catch (err) {
    return refusalOf(err);
  }
  return undefined;
}

describe("provider plugins in uploaded graphs", () => {
  it("refuses kind: plugin from an untrusted author with 403, also on a dry run", async () => {
    const s = await service();
    for (const dryRun of [true, false]) {
      expect(await refusal(s.startRun({ threadId: `p-${dryRun}`, yaml: withPlugin, input: {}, dryRun }, untrusted))).toMatchObject({
        status: 403,
        code: "PROVIDER_PLUGIN_BLOCKED",
      });
    }
  });

  it("answers an unregistered plugin from a trusted author with 400, not 500", async () => {
    const s = await service();
    expect(await refusal(s.startRun({ threadId: "p-missing", yaml: withPlugin, input: {} }, trusted))).toEqual({
      status: 400,
      code: "PROVIDER_PLUGIN_NOT_FOUND",
    });
  });

  it("maps PROVIDER_PLUGIN_NOT_FOUND to 400 and leaves other coded errors alone", () => {
    expect(refusalOf(Object.assign(new Error("x"), { code: "PROVIDER_PLUGIN_NOT_FOUND" }))).toEqual({ status: 400, code: "PROVIDER_PLUGIN_NOT_FOUND" });
    expect(refusalOf(Object.assign(new Error("x"), { code: "SOMETHING_ELSE" }))).toBeUndefined();
  });
});
