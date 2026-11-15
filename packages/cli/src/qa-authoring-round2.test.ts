import { expect,it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
it("PLAT-382: an imported mock provider wins over the built-in fallback",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-mock-import-"));
  try {
    writeFileSync(join(dir,"mock.mjs"),`export default [{name:'mock',capabilities:{toolCalling:false,structuredOutput:false,streaming:false},async run(){return {output:'CUSTOM-MOCK',stopReason:'done'};}}];`);
    const graph={apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"mock-import"},imports:[{providers:"./mock.mjs"}],nodes:[{id:"a",type:"agent",provider:"mock",with:{prompt:"test"}}],edges:[{from:"START",to:"a"},{from:"a",to:"END"}]};
    writeFileSync(join(dir,"g.yaml"),JSON.stringify(graph));
    const bin=resolve(import.meta.dirname,"../dist/bin.js");
    const result=spawnSync(process.execPath,[bin,"run","g.yaml","--json"],{cwd:dir,encoding:"utf8",timeout:20000});
    expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain("CUSTOM-MOCK");
    writeFileSync(join(dir,"g.yaml"),JSON.stringify({...graph,imports:[]}));
    const fallback=spawnSync(process.execPath,[bin,"run","g.yaml","--json"],{cwd:dir,encoding:"utf8",timeout:20000});
    expect(fallback.status,fallback.stderr).toBe(0);expect(fallback.stdout).not.toContain("CUSTOM-MOCK");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
