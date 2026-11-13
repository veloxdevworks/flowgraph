import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  FileWebhookDeliveryJournal,
  type WebhookDeliveryClaim,
  type WebhookDeliveryClaimResult,
} from "./webhook-delivery-journal.js";

const execFileAsync = promisify(execFile);
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});
const response = { http: 200, body: { status: "completed" } };
const scope = "opaque-integration";
let directory: string;

function journal(integration = scope): FileWebhookDeliveryJournal {
  return new FileWebhookDeliveryJournal(directory, integration);
}

function claimed(result: WebhookDeliveryClaimResult): WebhookDeliveryClaim {
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed") throw new Error("Expected a claimed delivery");
  return result.claim;
}

function hashed(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptPath(eventId: string): string {
  return path.join(directory, hashed(scope), "receipts", `${hashed(eventId)}.json`);
}

function lockPath(threadId: string): string {
  return path.join(directory, hashed(scope), "locks", hashed(threadId));
}

describe("FileWebhookDeliveryJournal", () => {
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "fg-webhook-journal-"));
  });

  afterEach(async () => {
    vi.mocked(fs.open).mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("syncs reused ancestors and refuses a claim when ancestor durability cannot be established", async () => {
    await journal().get("missing");
    const originalOpen = vi.mocked(fs.open).getMockImplementation()!;
    const ancestor = path.dirname(directory);
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === ancestor && args[1] === "r") {
        throw Object.assign(new Error("ancestor sync unavailable"), { code: "EIO" });
      }
      return originalOpen(...args);
    });
    await expect(journal().claim("new-event", "body", { threadId: "thread" })).rejects.toThrow(
      "ancestor sync unavailable",
    );
    expect(await fs.readdir(path.dirname(receiptPath("new-event")))).toEqual([]);
  });

  it("persists a claim before returning and never retries a pending delivery after restart", async () => {
    const first = claimed(
      await journal().claim("delivery-1", "body-1", {
        threadId: "thread-1",
        interruptId: "gate-1",
      }),
    );
    expect(first.receipt).toMatchObject({
      eventId: "delivery-1",
      fingerprint: "body-1",
      threadId: "thread-1",
      interruptId: "gate-1",
    });
    expect(first.receipt.response).toBeUndefined();

    const restarted = journal();
    expect(await restarted.get("delivery-1")).toEqual(first.receipt);
    expect(await restarted.claim("delivery-1", "body-1", { threadId: "different-target" })).toEqual(
      { kind: "duplicate", receipt: first.receipt },
    );
    expect(await restarted.claim("delivery-2", "body-2", { threadId: "thread-1" })).toEqual({
      kind: "busy",
    });
    expect(await restarted.get("delivery-2")).toBeNull();
  });

  it("replays the completed response after restart and releases the thread for another delivery", async () => {
    const first = journal();
    const claim = claimed(await first.claim("delivery-1", "body-1", { threadId: "thread-1" }));
    await first.complete(claim, response);

    const restarted = journal();
    expect(await restarted.claim("delivery-1", "body-1", { threadId: "thread-1" })).toMatchObject({
      kind: "duplicate",
      receipt: { response },
    });
    expect((await restarted.get("delivery-1"))?.response).toEqual(response);
    claimed(await restarted.claim("delivery-2", "body-2", { threadId: "thread-1" }));
  });

  it("rejects an event id reused with a different fingerprint before and after completion", async () => {
    const first = journal();
    const claim = claimed(
      await first.claim("same-event", "original-body", { threadId: "thread-1" }),
    );
    expect(await journal().claim("same-event", "changed-body", { threadId: "thread-2" })).toEqual({
      kind: "conflict",
    });
    await first.complete(claim, response);
    expect(await journal().claim("same-event", "changed-body", { threadId: "thread-2" })).toEqual({
      kind: "conflict",
    });
    claimed(await journal().claim("other-event", "body", { threadId: "thread-2" }));
  });

  it("allows at most one of many instances to claim the same event across different threads", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        journal().claim("same-event", "same-body", { threadId: `thread-${i}` }),
      ),
    );
    const winner = results.filter((result) => result.kind === "claimed");
    expect(winner).toHaveLength(1);
    expect(results.filter((result) => result.kind === "duplicate")).toHaveLength(15);
    // Losing contenders do not leave locks on their unrelated threads.
    for (const [i, result] of results.entries()) {
      if (result.kind !== "claimed")
        claimed(await journal().claim(`next-${i}`, "body", { threadId: `thread-${i}` }));
    }
  });

  it("serializes different event ids for one thread across journal instances", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        journal().claim(`event-${i}`, "body", { threadId: "one-thread" }),
      ),
    );
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(11);
  });

  it("coordinates exclusive claims in separate Node processes", async () => {
    const modulePath = fileURLToPath(new URL("./webhook-delivery-journal.ts", import.meta.url));
    const script = `
      import { pathToFileURL } from 'node:url';
      const { FileWebhookDeliveryJournal } = await import(pathToFileURL(process.argv[1]).href);
      const j = new FileWebhookDeliveryJournal(process.argv[2], process.argv[3]);
      const result = await j.claim('cross-process-event', 'same-body', { threadId: process.argv[4] });
      console.log(JSON.stringify({ kind: result.kind }));
    `;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        execFileAsync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
            modulePath,
            directory,
            scope,
            `process-thread-${i}`,
          ],
          { encoding: "utf8" },
        ),
      ),
    );
    const kinds = results.map((result) => (JSON.parse(result.stdout) as { kind: string }).kind);
    expect(kinds.filter((kind) => kind === "claimed")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "duplicate")).toHaveLength(3);
  });

  it("keeps integration scopes and arbitrary event/thread strings separate and inside the journal", async () => {
    const id = "../../outside/opaque\u0000event";
    const a = journal("scope-a");
    const b = journal("scope-b");
    const claimA = claimed(await a.claim(id, "body", { threadId: "../thread/../../outside" }));
    const claimB = claimed(
      await b.claim(id, "other-body", { threadId: "../thread/../../outside" }),
    );
    await a.complete(claimA, response);
    await b.complete(claimB, { http: 200, body: { status: "interrupted" } });
    expect((await a.get(id))?.response?.body).toEqual({ status: "completed" });
    expect((await b.get(id))?.response?.body).toEqual({ status: "interrupted" });
    expect((await fs.readdir(directory)).sort()).toEqual(
      [hashed("scope-a"), hashed("scope-b")].sort(),
    );
  });

  it("does not disclose or permit mutation of the ownership token through a claim", async () => {
    const j = journal();
    const claim = claimed(await j.claim("event", "body", { threadId: "thread" }));
    expect(Object.keys(claim.receipt)).not.toContain("claimToken");
    // Public receipt mutation cannot change the journal's private completion identity.
    claim.receipt.threadId = "another-thread";
    await j.complete(claim, response);
    expect((await j.get("event"))?.threadId).toBe("thread");
    await expect(journal().complete(claim, response)).rejects.toThrow("not owned");
    await expect(j.complete({ receipt: claim.receipt }, response)).rejects.toThrow("not owned");
  });

  it("makes repeated identical completion idempotent and rejects conflicting completion", async () => {
    const j = journal();
    const claim = claimed(await j.claim("event", "body", { threadId: "thread" }));
    await Promise.all([j.complete(claim, response), j.complete(claim, response)]);
    await j.complete(claim, response);
    await expect(j.complete(claim, { http: 500, body: { error: "changed" } })).rejects.toThrow(
      "different completion",
    );
    expect((await j.get("event"))?.response).toEqual(response);
  });

  it.each([
    "",
    "{",
    JSON.stringify({ version: 9 }),
    JSON.stringify({ version: 1, eventId: "event" }),
  ])("fails closed on an unreadable existing receipt (%j)", async (contents) => {
    const j = journal();
    claimed(await j.claim("event", "body", { threadId: "thread" }));
    await fs.writeFile(receiptPath("event"), contents);
    await expect(journal().get("event")).rejects.toThrow("reconciliation");
    await expect(journal().claim("event", "body", { threadId: "new-thread" })).rejects.toThrow(
      "reconciliation",
    );
    expect(await fs.readFile(receiptPath("event"), "utf8")).toBe(contents);
  });

  it("retains a crash-left thread lock even when no receipt was published", async () => {
    const j = journal();
    await j.get("missing");
    await fs.mkdir(lockPath("crashed-thread"), { mode: 0o700 });
    expect(await journal().claim("new-event", "body", { threadId: "crashed-thread" })).toEqual({
      kind: "busy",
    });
    expect(await j.get("new-event")).toBeNull();
  });

  it("refuses completion when the thread lock no longer belongs to the claim", async () => {
    const j = journal();
    const claim = claimed(await j.claim("event", "body", { threadId: "thread" }));
    const ownerFile = path.join(lockPath("thread"), "owner.json");
    const changedOwner = JSON.stringify({
      eventId: "different-event",
      claimToken: "different-token",
    });
    await fs.writeFile(ownerFile, changedOwner);
    await expect(j.complete(claim, response)).rejects.toThrow("ownership changed");
    expect((await j.get("event"))?.response).toBeUndefined();
    expect(await fs.readFile(ownerFile, "utf8")).toBe(changedOwner);
    expect(await journal().claim("another-event", "body", { threadId: "thread" })).toEqual({
      kind: "busy",
    });
  });

  it("creates owner-only journal files and leaves no completed temporary files", async () => {
    const j = journal();
    const claim = claimed(await j.claim("event", "body", { threadId: "thread" }));
    expect((await fs.stat(receiptPath("event"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(lockPath("thread"))).mode & 0o777).toBe(0o700);
    await j.complete(claim, response);
    expect(await fs.readdir(path.dirname(receiptPath("event")))).toEqual([
      `${hashed("event")}.json`,
    ]);
    expect(await fs.readdir(path.dirname(lockPath("thread")))).toEqual([]);
  });
});
