/**
 * mock-create-ticket handler.
 *
 * When TRACKER_URL is set, posts to the real API.
 * Without it, returns a synthetic ticket (mock mode) — useful in CI and tests.
 */

let _counter = 1;

/**
 * @param {Record<string, unknown>} input
 * @param {import('@veloxdevworks/flowgraph-core').NodeRunContext} ctx
 * @returns {Promise<{key: string, url: string, type: string, title: string}>}
 */
export default async function createTicket(input, ctx) {
  const { project = "DEMO", type = "question", title = "Untitled", description = "" } = input;
  const trackerUrl = process.env.TRACKER_URL;
  const apiKey = process.env.TRACKER_API_KEY;

  ctx?.logger?.debug("mock-create-ticket", { project, type, title, hasCreds: Boolean(apiKey) });

  if (trackerUrl && apiKey) {
    // Real API path
    const resp = await fetch(`${trackerUrl}/rest/api/2/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        fields: {
          project: { key: project },
          issuetype: { name: type === "bug" ? "Bug" : type === "feature" ? "Story" : "Task" },
          summary: title,
          description,
        },
      }),
      signal: ctx?.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Tracker API error ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const key = data.key;
    return { key, url: `${trackerUrl}/browse/${key}`, type, title };
  }

  // Mock mode — no network required
  const key = `${project}-${_counter++}`;
  ctx?.logger?.info(`[mock] created ticket ${key}`, { type, title });
  return { key, url: `https://mock.tracker.local/browse/${key}`, type, title };
}
