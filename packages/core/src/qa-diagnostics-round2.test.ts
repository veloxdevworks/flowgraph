import { afterEach, expect, it } from "vitest";
import { GraphSpecSchema, diagnosticsFromZodIssues } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { createScriptedProvider } from "./providers/mock.js";
import { graphEdges } from "./runtime/validate-graph.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const graph=(node:unknown)=>GraphSpecSchema.parse({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"diagnostics-round2"},nodes:[node],edges:[{from:"START",to:"work"},{from:"work",to:"END"}]});
it("PLAT-368: typed errors retain their code and unprefixed text in node/run events",async()=>{
  const provider=createScriptedProvider("broken",()=>{throw Object.assign(new Error("Error: Error: useful reason"),{code:"AGENT_OUTPUT_INVALID",retryable:false});});
  const g=await compileGraph(graph({id:"work",type:"agent",provider:"broken",with:{prompt:"test"}}),{providers:[provider]});
  const errors:unknown[]=[];g.events.subscribe(e=>{if(["node.error","run.error"].includes(e.type))errors.push(e.data);});
  expect((await g.run()).status).toBe("error");
  expect(errors.length).toBeGreaterThanOrEqual(2);
  for(const error of errors)expect(error).toMatchObject({code:"AGENT_OUTPUT_INVALID",error:"useful reason"});
});
it("PLAT-383: invalid provider stop reasons name the allowed values",async()=>{
  const provider=createScriptedProvider("bad-stop",()=>({output:"ignored",stopReason:"end" as never}));
  const result=await(await compileGraph(graph({id:"work",type:"agent",provider:"bad-stop",with:{prompt:"test"}}),{providers:[provider]})).run();
  expect(result.error?.message).toMatch(/done, maxSteps, interrupted, error/);
});
it("PLAT-383/384: script failures name their node and missing module export",async()=>{
  const result=await(await compileGraph(graph({id:"work",type:"script",with:{code:"return 42;"}}))).run();
  expect(result.error?.message).toContain('script node "work"');
  expect(result.error?.message).toContain("export default");
  expect(result.error?.message).not.toMatch(/\n\s+at /);
});
it("PLAT-383: media token usage enters run totals and reused results do not double charge",async()=>{
  const cwd=await mkdtemp(join(tmpdir(),"fg-image-usage-"));dirs.push(cwd);
  const spec=graph({id:"work",type:"image",provider:"image-usage",with:{prompt:"draw"}});
  const g=await compileGraph(spec,{cwd,mediaProviders:[{name:"image-usage",vendor:"test",modalities:["image"],start:async(_req,ctx)=>({id:"done",done:[await ctx.saveOutput({bytes:Uint8Array.from([137,80,78,71,13,10,26,10]),mimeType:"image/png"})],usage:{inputTokens:50,outputTokens:100,totalTokens:150},costUSD:0.1})}]});
  expect(await g.run({threadId:"tokens"})).toMatchObject({status:"completed",usage:{inputTokens:50,outputTokens:100,totalTokens:150,costUSD:0.1}});
  expect(await g.run({threadId:"tokens"})).toMatchObject({status:"completed",usage:{inputTokens:50,outputTokens:100,totalTokens:150,costUSD:0.1,calls:1}});
});
it("PLAT-384: route topology uses declared outcome names",()=>{
  const spec=graph({id:"work",type:"hitl",with:{mode:"approve",message:"go?",routes:{approved:"END",rejected:"END"}}});
  expect(graphEdges(spec).filter(e=>e.from==="work").map(e=>e.label)).toEqual(["approved","rejected"]);
});
it.each([{description:"here"},{nodes:[{id:"work",type:"subgraph",output:{to:"result"}}]}])("PLAT-384: validation suggests the nested field: %j",extra=>{
  const raw={apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"hints"},nodes:[],edges:[],...extra};
  const result=GraphSpecSchema.safeParse(raw);expect(result.success).toBe(false);
  if(!result.success)expect(diagnosticsFromZodIssues(result.error.issues,raw).map(d=>d.message).join(" ")).toMatch(/Use metadata.description|with.output/);
});
