/** Example adapter: sign the exact UTF-8 bytes that will be delivered. */
import { createHmac } from "node:crypto";

const [url, deliveryId, externalId, nodeId, answer] = process.argv.slice(2);
if (!url || !deliveryId || !externalId || !nodeId || answer === undefined) {
  throw new Error(
    "Usage: node send.mjs <url> <stable-delivery-id> <external-id> <node-id> <answer>",
  );
}
const secret = process.env.FLOWGRAPH_WEBHOOK_SECRET;
if (!secret) throw new Error("Set FLOWGRAPH_WEBHOOK_SECRET");
const body = JSON.stringify({ correlation: { external: externalId }, nodeId, payload: { answer } });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret)
  .update(`${timestamp}.${deliveryId}.${new URL(url).pathname}.`)
  .update(body)
  .digest("hex");
const response = await fetch(url, {
  method: "POST",
  body,
  headers: {
    "Content-Type": "application/json",
    "X-Flowgraph-Delivery-Id": deliveryId,
    "X-Flowgraph-Timestamp": timestamp,
    "X-Flowgraph-Signature": `sha256=${signature}`,
  },
  signal: AbortSignal.timeout(30_000),
});
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
