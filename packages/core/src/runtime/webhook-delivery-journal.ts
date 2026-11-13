import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WebhookDeliveryResponse {
  http: number;
  body: Record<string, unknown>;
}

export interface WebhookDeliveryReceipt {
  eventId: string;
  fingerprint: string;
  threadId: string;
  interruptId?: string;
  createdAt: string;
  response?: WebhookDeliveryResponse;
}

/** Only the journal instance which made a claim can complete it. */
export interface WebhookDeliveryClaim {
  readonly receipt: WebhookDeliveryReceipt;
}

export type WebhookDeliveryClaimResult =
  | { kind: "claimed"; claim: WebhookDeliveryClaim }
  | { kind: "duplicate"; receipt: WebhookDeliveryReceipt }
  | { kind: "conflict" }
  | { kind: "busy" };

interface StoredReceipt extends WebhookDeliveryReceipt {
  version: 1;
  claimToken: string;
}

interface OwnedClaim {
  stored: StoredReceipt;
  lock: string;
  completion?: Promise<void>;
  responseFingerprint?: string;
}

/**
 * Durable, at-most-once delivery claims on one shared local filesystem.
 *
 * A claim is fsynced before the caller may invoke a resume. A completed receipt
 * replays the original HTTP response. A pending receipt or a crash-left thread
 * lock is deliberately never expired: it is unsafe to guess whether a resume
 * committed before the process stopped. Such deliveries need reconciliation by
 * the host, rather than another invocation. Do not place this on a filesystem
 * without atomic mkdir/link/rename and working fsync semantics.
 */
export class FileWebhookDeliveryJournal {
  private readonly directory: string;
  private readonly receipts: string;
  private readonly locks: string;
  private readonly owned = new WeakMap<WebhookDeliveryClaim, OwnedClaim>();
  private initialized: Promise<void> | undefined;

  constructor(directory: string, scope: string) {
    requireText(directory, "directory");
    requireText(scope, "scope");
    this.directory = path.join(path.resolve(directory), digest(scope));
    this.receipts = path.join(this.directory, "receipts");
    this.locks = path.join(this.directory, "locks");
  }

  async get(eventId: string): Promise<WebhookDeliveryReceipt | null> {
    requireText(eventId, "eventId");
    await this.initialize();
    const stored = await this.readStored(eventId);
    return stored ? publicReceipt(stored) : null;
  }

  async claim(
    eventId: string,
    fingerprint: string,
    target: { threadId: string; interruptId?: string },
  ): Promise<WebhookDeliveryClaimResult> {
    requireText(eventId, "eventId");
    requireText(fingerprint, "fingerprint");
    requireText(target.threadId, "threadId");
    if (target.interruptId !== undefined) requireText(target.interruptId, "interruptId");
    await this.initialize();

    const prior = await this.readStored(eventId);
    if (prior) return duplicate(prior, fingerprint);

    const lock = path.join(this.locks, digest(target.threadId));
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        // The first claimant may have published this event while we checked.
        const receipt = await this.readStored(eventId);
        return receipt ? duplicate(receipt, fingerprint) : { kind: "busy" };
      }
      throw error;
    }

    const stored: StoredReceipt = {
      version: 1,
      claimToken: randomUUID(),
      eventId,
      fingerprint,
      threadId: target.threadId,
      ...(target.interruptId !== undefined ? { interruptId: target.interruptId } : {}),
      createdAt: new Date().toISOString(),
    };
    // If this write fails, retain the lock. No process may assume ownership of
    // an incomplete claim left behind by an I/O error or process termination.
    await writeSynced(
      path.join(lock, "owner.json"),
      JSON.stringify({
        eventId,
        claimToken: stored.claimToken,
      }),
    );
    await syncDirectory(lock);
    await syncDirectory(this.locks);

    // A different thread can race for the same event id. Publish a complete,
    // fsynced inode by exclusive hard link, so readers never see partial JSON.
    // I/O errors retain our lock: the durable state may be uncertain.
    const published = await this.publishClaim(stored);
    if (!published) {
      try {
        const receipt = await this.readStored(eventId);
        if (!receipt) throw new Error("Webhook receipt disappeared during delivery claim");
        return duplicate(receipt, fingerprint);
      } finally {
        await this.releaseLock(lock, stored);
      }
    }
    const claim: WebhookDeliveryClaim = Object.freeze({ receipt: publicReceipt(stored) });
    this.owned.set(claim, { stored, lock });
    return { kind: "claimed", claim };
  }

  async complete(claim: WebhookDeliveryClaim, response: WebhookDeliveryResponse): Promise<void> {
    const owned = this.owned.get(claim);
    if (!owned) throw new Error("Webhook delivery claim is not owned by this journal instance");
    const serialized = JSON.stringify(response);
    const checked = parseResponse(JSON.parse(serialized) as unknown);
    const responseFingerprint = digest(serialized);
    if (owned.completion) {
      if (owned.responseFingerprint !== responseFingerprint) {
        throw new Error("Webhook delivery claim already has a different completion response");
      }
      return owned.completion;
    }
    owned.responseFingerprint = responseFingerprint;
    owned.completion = this.completeOwned(owned, checked);
    return owned.completion;
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await fs.mkdir(this.receipts, { recursive: true, mode: 0o700 });
      await fs.mkdir(this.locks, { recursive: true, mode: 0o700 });
      await syncDirectory(this.locks);
      // Another initializer may have created these ancestors but not synced
      // them yet. Sync the complete ancestry even when our mkdir reused it.
      await syncDirectoryAncestry(this.receipts);
    })();
    return this.initialized;
  }

  private receiptPath(eventId: string): string {
    return path.join(this.receipts, `${digest(eventId)}.json`);
  }

  private async readStored(eventId: string): Promise<StoredReceipt | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.receiptPath(eventId), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const stored = parseStored(JSON.parse(raw) as unknown);
      if (stored.eventId !== eventId) throw new Error("Receipt event id does not match its key");
      return stored;
    } catch {
      // Do not include persisted contents (or external ids) in diagnostics.
      throw new Error("Webhook delivery receipt is unreadable; reconciliation is required");
    }
  }

  private async publishClaim(stored: StoredReceipt): Promise<boolean> {
    const temporary = path.join(this.receipts, `.${randomUUID()}.tmp`);
    try {
      await writeSynced(temporary, JSON.stringify(stored));
      try {
        await fs.link(temporary, this.receiptPath(stored.eventId));
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
      await syncDirectory(this.receipts);
      return true;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async completeOwned(owned: OwnedClaim, response: WebhookDeliveryResponse): Promise<void> {
    const current = await this.readStored(owned.stored.eventId);
    if (!current || current.claimToken !== owned.stored.claimToken || current.response) {
      throw new Error("Webhook delivery receipt ownership changed before completion");
    }
    await this.checkLockOwner(owned.lock, owned.stored);
    const temporary = path.join(this.receipts, `.${randomUUID()}.tmp`);
    try {
      await writeSynced(temporary, JSON.stringify({ ...owned.stored, response }));
      await fs.rename(temporary, this.receiptPath(owned.stored.eventId));
      await syncDirectory(this.receipts);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await this.releaseLock(owned.lock, owned.stored);
  }

  private async checkLockOwner(lock: string, stored: StoredReceipt): Promise<void> {
    let owner: unknown;
    try {
      owner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as unknown;
    } catch {
      throw new Error("Webhook thread lock is unreadable; reconciliation is required");
    }
    if (
      !isRecord(owner) ||
      owner["claimToken"] !== stored.claimToken ||
      owner["eventId"] !== stored.eventId
    ) {
      throw new Error("Webhook thread lock ownership changed; reconciliation is required");
    }
  }

  private async releaseLock(lock: string, stored: StoredReceipt): Promise<void> {
    await this.checkLockOwner(lock, stored);
    await fs.unlink(path.join(lock, "owner.json"));
    await fs.rmdir(lock);
    await syncDirectory(this.locks);
  }
}

function publicReceipt(stored: StoredReceipt): WebhookDeliveryReceipt {
  const { version: _version, claimToken: _claimToken, ...receipt } = stored;
  return receipt;
}

function duplicate(stored: StoredReceipt, fingerprint: string): WebhookDeliveryClaimResult {
  return stored.fingerprint === fingerprint
    ? { kind: "duplicate", receipt: publicReceipt(stored) }
    : { kind: "conflict" };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Webhook journal ${field} must be a non-empty string`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResponse(value: unknown): WebhookDeliveryResponse {
  if (
    !isRecord(value) ||
    !Number.isInteger(value["http"]) ||
    Number(value["http"]) < 100 ||
    Number(value["http"]) > 599 ||
    !isRecord(value["body"])
  ) {
    throw new Error("Invalid webhook delivery response");
  }
  return { http: value["http"] as number, body: value["body"] };
}

function parseStored(value: unknown): StoredReceipt {
  if (!isRecord(value) || value["version"] !== 1)
    throw new Error("Invalid webhook receipt version");
  for (const field of ["claimToken", "eventId", "fingerprint", "threadId", "createdAt"] as const)
    requireText(value[field], field);
  if (!Number.isFinite(Date.parse(value["createdAt"] as string)))
    throw new Error("Invalid webhook receipt timestamp");
  if (value["interruptId"] !== undefined) requireText(value["interruptId"], "interruptId");
  return {
    version: 1,
    claimToken: value["claimToken"] as string,
    eventId: value["eventId"] as string,
    fingerprint: value["fingerprint"] as string,
    threadId: value["threadId"] as string,
    createdAt: value["createdAt"] as string,
    ...(value["interruptId"] !== undefined ? { interruptId: value["interruptId"] as string } : {}),
    ...(value["response"] !== undefined ? { response: parseResponse(value["response"]) } : {}),
  };
}

async function writeSynced(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryAncestry(directory: string): Promise<void> {
  let current = directory;
  for (;;) {
    await syncDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
