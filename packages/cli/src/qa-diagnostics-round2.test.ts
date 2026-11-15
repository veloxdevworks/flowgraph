import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const bin=resolve(import.meta.dirname,"../dist/bin.js");
it("PLAT-368: pre-admission refusals and graph load errors emit JSON error events",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-json-errors-"));
  const cli=(...args:string[])=>spawnSync(process.execPath,[bin,...args],{cwd:dir,encoding:"utf8",env:{...process.env,FLOWGRAPH_LOG_LEVEL:"warn"},timeout:20000});
  try{
    writeFileSync(join(dir,"g.yaml"),JSON.stringify({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"refused"},nodes:[{id:"gate",type:"hitl",with:{mode:"approve",message:"go?"}}],edges:[{from:"START",to:"gate"},{from:"gate",to:"END"}],runtime:{checkpoint:{backend:"sqlite",path:"state.db"}}}));
    expect(cli("run","g.yaml","--thread","t","--on-interrupt","fail","--json").status).toBe(3);
    writeFileSync(join(dir,"invalid.yaml"),JSON.stringify({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"invalid"},nodes:[{id:"bad",type:"shell",with:{}}],edges:[{from:"START",to:"bad"},{from:"bad",to:"END"}]}));
    for(const [args,code] of [[ ["run","g.yaml","--json","--bogus"],"CLI_ARGUMENT_INVALID" ],[ ["run","invalid.yaml","--json"],"GRAPH_VALIDATION_FAILED" ],[ ["resume","g.yaml","--thread","t","--json"],"RESUME_VALUE_REQUIRED" ],[ ["run","missing.yaml","--json"],"GRAPH_LOAD_FAILED" ]] as const){
      const result=cli(...args);expect(result.status).not.toBe(0);
      const events=result.stdout.trim().split("\n").map(line=>JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({type:"run.error",ts:expect.any(String),data:expect.objectContaining({code})}));
      expect(result.stderr).toContain(code);expect(result.stderr).not.toMatch(/\n\s+at /);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it("PLAT-368: failed JSON runs print a reason even when ordinary logs are quiet",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-json-failure-"));
  try{
    writeFileSync(join(dir,"g.yaml"),JSON.stringify({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"failure"},nodes:[{id:"reject",type:"fail",with:{reason:"rejected-for-test"}}],edges:[{from:"START",to:"reject"},{from:"reject",to:"END"}]}));
    const result=spawnSync(process.execPath,[bin,"run","g.yaml","--json"],{cwd:dir,encoding:"utf8",env:{...process.env,FLOWGRAPH_LOG_LEVEL:"warn"}});
    expect(result.status).toBe(1);expect(result.stderr).toContain("rejected-for-test");
    expect(result.stdout.trim().split("\n").map(line=>JSON.parse(line))).toContainEqual(expect.objectContaining({type:"run.error",data:expect.objectContaining({code:"FLOW_FAILED"})}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
