# @flowgraph/workshop-session

Client session layer for the flowgraph `workshop` node (ADR-0016, ADR-0021). Depends only on
`@flowgraph/spec`; no SDKs (adapters use `fetch`). The root entry is environment-neutral; browser
code lives in `@flowgraph/workshop-session/browser`.

`WorkshopController` owns the session (draft, agenda coverage, transcript, limits) and produces the
resume value. Text, voice and form facilitators all end in `controller.toResume()`.

## Text facilitator (Node)

```ts
import { WorkshopController, TextFacilitator, anthropicModel } from "@flowgraph/workshop-session";

// `contract` is the interrupt payload data of the workshop node
const controller = new WorkshopController(contract);
const model = anthropicModel({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "<model id>" });
// or: openAICompatibleModel({ apiKey, model, baseUrl: "https://api.x.ai/v1" })
const facilitator = new TextFacilitator(controller, model);

console.log((await facilitator.start()).reply);
while (!controller.ended) {
  const { reply } = await facilitator.send(await readLineFromHuman());
  console.log(reply);
}
resume(controller.toResume()); // { output, transcript, coverage, endedReason }
```

`finish` is refused (session stays open, the result lists what is missing) while the draft fails
`checkWorkshopOutput`, including `requireCoverage`. `limits.maxTurns` makes the status tell the
model to wrap up.

## Dictation (browser) and a host transcriber

```ts
// browser
import { startDictation } from "@flowgraph/workshop-session/browser";
const rec = await startDictation({ maxSeconds: 60, onLevel: (rms) => drawMeter(rms) });
const { wav } = await rec.stop();
const text = await fetch("/transcribe", { method: "POST", body: wav }).then((r) => r.text());
inputBox.value = text; // the human checks it, then sends

// host (API key stays here)
import { openAICompatibleTranscriber, transcriptionPrompt } from "@flowgraph/workshop-session";
const transcriber = openAICompatibleTranscriber({ apiKey, model: "<stt model>" });
const text = await transcriber.transcribe(wavBytes, { mimeType: "audio/wav", prompt: transcriptionPrompt(contract) });
```

## Form editing

```ts
const unsubscribe = controller.subscribe((s) => render(s.draft, s.coverage));
controller.setField("owner.name", "Ada"); // dot paths; intermediate objects are created
controller.cover("scope", "agreed in review");
controller.check(); // { complete, error?, missing, uncovered }
controller.end("completed"); // throws (session stays open) if the engine would reject it
```

`end("human_ended" | "timeout" | "skipped")` may finish an incomplete draft only when the contract
sets `allowPartial`.

## Snapshot and restore

```ts
localStorage.setItem("ws", JSON.stringify(controller.snapshot()));
// after a crash or reconnect
const restored = WorkshopController.restore(contract, JSON.parse(localStorage.getItem("ws")!));
// throws if the agenda ids or schema differ from the snapshot's contract
const facilitator = new TextFacilitator(restored, model); // history rebuilt from the transcript
await facilitator.start(); // resumes
```

## Realtime voice

```ts
const session = new WorkshopSession(token, contract, events, undefined, { controller });
await session.start(); // controller tools + instructions; tool calls applied; transcripts recorded
```

With a controller the socket closes on an accepted `finish` (`events.onFinished`) and a time-limit
stop ends the controller with `timeout` when the contract allows it.
