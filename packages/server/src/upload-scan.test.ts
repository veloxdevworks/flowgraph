import { describe, expect, it } from "vitest";
import { parseGraphYaml } from "./graph-source.js";
import { checkUntrustedUpload, findEnvPlaceholder } from "./upload-policy.js";

const TWO_MB = 2 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(TWO_MB / unit.length));

/**
 * The fastest of three runs, in ms. A shared CI runner can stall one run on
 * GC or a busy neighbour; quadratic work stays slow on every run.
 */
function timed(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** A one-node graph whose hitl message is `message`, as raw YAML. */
const graphWith = (message: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: upload-scan }
state:
  channels:
    out: { type: string }
nodes:
  - { id: a, type: hitl, with: { mode: approve, message: ${JSON.stringify(message)}, input: { x: ${JSON.stringify(message)} } } }
edges:
  - { from: START, to: a }
  - { from: a, to: END }
`;

function check(message: string): { ms: number; codes: string[] } {
  const yaml = graphWith(message);
  const parsed = parseGraphYaml(yaml, { expandEnv: false });
  expect(parsed.spec).not.toBeNull();
  let codes: string[] = [];
  const ms = timed(() => {
    codes = checkUntrustedUpload(yaml, parsed.spec!).map((v) => `${v.code} ${v.path}`);
  });
  return { ms, codes };
}

// Each timing is the best of three runs over several 2 MB graphs, so allow
// more than the default per-test timeout for the whole case.
describe("checkUntrustedUpload on slow input", { timeout: 30_000 }, () => {
  it("checks 2 MB of unclosed, repeated and nested braces in well under a second", () => {
    const messages = [fill("{{ "), fill("{{"), fill("{{ a }}"), `{{${fill(" {{")}}}`, fill("{{ a }} {{ "), fill("${a:-"), fill("${")];
    for (const message of messages) {
      const { ms, codes } = check(message);
      expect(ms, message.slice(0, 12)).toBeLessThan(1000);
      // The `}` that closes the YAML flow mapping on the same line ends a `${a:-`.
      expect(codes.filter((c) => !c.startsWith("UPLOAD_ENV_PLACEHOLDER_BLOCKED")), message.slice(0, 12)).toEqual([]);
    }
  });

  it("refuses, quickly, a string with more indexed blocks than the check parses", () => {
    const { ms, codes } = check(fill("{{ x[''] }}"));
    expect(ms).toBeLessThan(1000);
    expect(codes).toContain("UPLOAD_RESERVED_CHANNEL_BLOCKED nodes.a.with.message");
    expect(check("{{ x[''] }}".repeat(500)).codes).toEqual([]);
  });

  it("still finds secrets and reserved reads among many blocks", () => {
    const { ms, codes } = check(`${fill("{{ a }} {{ ")} {{ secret.KEY`);
    expect(ms).toBeLessThan(1000);
    expect(codes).toContain("UPLOAD_SECRET_REFERENCE_BLOCKED nodes[0].with.message");
    expect(check(`${fill("{{ a }}")}{{ state.__x }}`).codes).toContain("UPLOAD_RESERVED_CHANNEL_BLOCKED nodes.a.with.message");
    expect(check("{{ a } secret.KEY }}").codes).toContain("UPLOAD_SECRET_REFERENCE_BLOCKED nodes[0].with.message");
    expect(check("x ${HOME} y").codes).toContain("UPLOAD_ENV_PLACEHOLDER_BLOCKED line 9");
  });
});

describe("findEnvPlaceholder", () => {
  const ENV_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;

  it("finds what the regular expression it replaces found, on random lines", () => {
    const alphabet = ["$", "{", "}", "${", ":-", ":", "-", "a", "Z", "_", "9", " "];
    let x = 7;
    for (let n = 0; n < 5000; n++) {
      let line = "";
      for (let i = 0; i < 1 + (n % 30); i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        line += alphabet[x % alphabet.length];
      }
      expect(findEnvPlaceholder(line), line).toBe(ENV_PLACEHOLDER.exec(line)?.[0]);
    }
  });

  it("runs in linear time", () => {
    for (const line of [fill("${a:-"), fill("${"), fill("${a"), fill("${a:-}")]) {
      expect(timed(() => findEnvPlaceholder(line)), line.slice(0, 8)).toBeLessThan(500);
    }
    expect(findEnvPlaceholder("a ${B:-c} ${D}")).toBe("${B:-c}");
  });
});
