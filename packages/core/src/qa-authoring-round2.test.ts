import { expect, it, vi } from "vitest";
import { GraphSpecSchema } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { templateRefs, templateRootRefs } from "./node-policy.js";
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
it("rejects unknown hook directives instead of silently removing an approval",async()=>{
  const spec=graph();spec.runtime={hooks:[{on:"node:before",do:"interupt"}]};
  expect(validateSpec(spec)).toContainEqual(expect.objectContaining({code:"HOOK_DIRECTIVE_UNKNOWN"}));
  await expect(compileGraph(spec)).rejects.toMatchObject({code:"HOOK_DIRECTIVE_UNKNOWN"});
});
it("validates and scans literal callback bodies, including escaped secret references",()=>{
  const text=String.raw`{{ map([1], 'se\cret.TOKEN') }}`;
  expect(templateRefs(text).secret).toBe(true);
  expect(templateRootRefs(text,new Set(["secret"]))).toContain("secret.TOKEN");
  const spec=graph();spec.nodes[0]!.with={routes:{done:{default:true,to:"END"}},unused:"{{ map([1], 'unknownHelper(item)') }}"};
  expect(validateSpec(spec)).toContainEqual(expect.objectContaining({code:"EXPR_UNKNOWN_FUNCTION"}));
  spec.nodes[0]!.with.unused="{{ map([1], state.mapper) }}";
  expect(validateSpec(spec)).toContainEqual(expect.objectContaining({code:"EXPR_CALLBACK_LITERAL"}));
});
