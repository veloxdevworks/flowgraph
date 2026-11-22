import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RunService, type Principal, type ServerAuthConfig } from "./index.js";

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

function principal(subject: string, trusted: boolean): Principal {
  return {
    id: `iss|${subject}`,
    subject,
    org: "acme",
    teams: [],
    roles: trusted ? ["author"] : [],
    trusted,
    via: "oidc",
  };
}

const WORKSHOP_DIFF_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: workshop-check
nodes:
  - id: ws
    type: workshop
    with:
      message: "Discuss changes"
      agenda: ["Check diff"]
      diff:
        cwd: "."
edges:
  - from: START
    to: ws
  - from: ws
    to: END
`;

const PORT_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: port-check
state:
  channels:
    port: { type: number }
nodes:
  - id: p
    type: port
    with:
      output: { to: port }
edges:
  - from: START
    to: p
  - from: p
    to: END
`;

describe("standalone server product node registration", () => {
  it("allows trusted runs to use workshop and port nodes while refusing untrusted uploads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-server-product-nodes-"));
    const service = new RunService({
      host: "127.0.0.1",
      port: 0,
      graphStoreDir: dir,
      eventBufferSize: 50,
      auth: OIDC,
    });
    await service.init();
    try {
      const trusted = principal("alice", true);
      const untrusted = principal("bob", false);

      // Trusted run can start a workshop node with host diff.
      const wsRun = await service.startRun({ threadId: "ws-trusted", yaml: WORKSHOP_DIFF_GRAPH }, trusted);
      expect(wsRun.threadId).toBe("ws-trusted");

      // Untrusted upload of the same workshop graph is refused.
      await expect(
        service.startRun({ threadId: "ws-untrusted", yaml: WORKSHOP_DIFF_GRAPH }, untrusted),
      ).rejects.toMatchObject({ status: 403, code: "UPLOAD_HOST_PATH_BLOCKED" });
      expect(await service.getRun("ws-untrusted", untrusted)).toBeNull();

      // Trusted run can start a port node; untrusted upload is refused by default-deny.
      const portRun = await service.startRun({ threadId: "port-trusted", yaml: PORT_GRAPH }, trusted);
      expect(portRun.threadId).toBe("port-trusted");

      await expect(
        service.startRun({ threadId: "port-untrusted", yaml: PORT_GRAPH }, untrusted),
      ).rejects.toMatchObject({ status: 403, code: "UPLOAD_NODE_TYPE_BLOCKED" });
      expect(await service.getRun("port-untrusted", untrusted)).toBeNull();
    } finally {
      await service.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
