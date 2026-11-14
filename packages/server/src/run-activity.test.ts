import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RunService } from "./run-service.js";

const yaml = `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: content-approval
  labels: { category: content, customer: "{{ input.customer }}" }
state:
  channels:
    customer: { type: string }
    approval: { type: object }
nodes:
  - id: review
    type: hitl
    with: { mode: approve, message: "Approve?", output: { to: approval } }
edges:
  - { from: START, to: review }
  - { from: review, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl: { onInterrupt: fail }
`;
const services: RunService[] = [];
let dir: string;
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function open() {
  const service = new RunService({
    host: "127.0.0.1",
    port: 0,
    graphStoreDir: dir,
    eventBufferSize: 100,
  });
  await service.init();
  services.push(service);
  return service;
}
async function waitFor(service: RunService, threadId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    if (service.registry.get(threadId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not reach ${status}`);
}
it("lists human waits and declared labels, preserves the clock through polls and restart", async () => {
  dir = await mkdtemp(join(tmpdir(), "fg-active-"));
  const service = await open();
  await service.startRun({ threadId: "same-thread", yaml, input: { customer: "Acme" } });
  await waitFor(service, "same-thread", "interrupted");
  const state = (await service.getState("same-thread")).state;
  const [run] = await service.listRuns(undefined, { activeOnly: true });
  expect(run).toMatchObject({
    graphName: "content-approval",
    labels: { category: "content", customer: "Acme" },
    status: "interrupted",
    activity: { phase: "interrupted", currentNodes: ["review"], waitingOn: "you" },
  });
  expect(await service.listRuns(undefined, { activeOnly: true })).toEqual([run]);
  expect((await service.getState("same-thread")).state).toEqual(state);
  const [latest] = await service.listRuns(undefined, { activeOnly: true });
  await service.close();
  const restarted = await open();
  expect(await restarted.listRuns(undefined, { activeOnly: true })).toEqual([latest]);
});

it("excludes completed runs while preserving the default history endpoint", async () => {
  dir = await mkdtemp(join(tmpdir(), "fg-active-finish-"));
  const service = await open();
  await service.startRun({ threadId: "finished", yaml, input: { customer: "Acme" } });
  await waitFor(service, "finished", "interrupted");
  await service.resumeRun({ threadId: "finished", resume: true });
  await waitFor(service, "finished", "completed");
  expect(await service.listRuns(undefined, { activeOnly: true })).toEqual([]);
  expect(await service.listRuns()).toMatchObject([
    { status: "completed", activity: { phase: "completed", currentNodes: [], waitingOn: null } },
  ]);
});

it("does not leave rejected input visible as an active run", async () => {
  dir = await mkdtemp(join(tmpdir(), "fg-active-invalid-"));
  const service = await open();
  const requiredInput = yaml.replace("state:\n", "inputs:\n  - { key: customer, type: string, required: true }\nstate:\n");
  await expect(service.startRun({ threadId: "invalid", yaml: requiredInput, input: {} })).rejects.toThrow();
  expect(await service.listRuns(undefined, { activeOnly: true })).toEqual([]);
  expect(await service.listRuns()).toMatchObject([{ status: "error", activity: { phase: "failed" } }]);
});
