import { expect, it, vi } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
const graph=()=>GraphSpecSchema.parse({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"authoring"},nodes:[{id:"end",type:"router",with:{routes:{done:{default:true,to:"END"}}}}],edges:[{from:"START",to:"end"}]});
it("PLAT-381: undeclared run inputs emit a named warning instead of disappearing silently",async()=>{
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{
    const g=await compileGraph(graph());const logs:unknown[]=[];g.events.subscribe(e=>{if(e.type==="log")logs.push(e.data);});
    expect((await g.run({input:{typo:"lost"}})).status).toBe("completed");
    expect(logs).toContainEqual(expect.objectContaining({code:"INPUT_UNKNOWN_KEY",keys:["typo"]}));
  }finally{warn.mockRestore();}
});
it("PLAT-381: unknown hook phases fail offline validation and programmatic compile",async()=>{
  const spec=graph();spec.runtime={hooks:[{on:"node:befroe",do:"interrupt"}]};
  expect(validateSpec(spec)).toContainEqual(expect.objectContaining({code:"HOOK_PHASE_UNKNOWN",severity:"error"}));
  await expect(compileGraph(spec)).rejects.toMatchObject({code:"HOOK_PHASE_UNKNOWN"});
});
