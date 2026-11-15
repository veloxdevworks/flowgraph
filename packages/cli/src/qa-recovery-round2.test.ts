import { replayInspection } from "./recovery-command.js";
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const bin=resolve(import.meta.dirname,"../dist/bin.js");
it("PLAT-365: discovers checkpoints and all crash blockers without executing the graph",{timeout:20_000},()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-recover-cli-"));
  const cli=(...args:string[])=>spawnSync(process.execPath,[bin,...args],{cwd:dir,encoding:"utf8",timeout:20000});
  try {
    writeFileSync(join(dir,"g.yaml"),JSON.stringify({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"recover"},nodes:[{id:"gate",type:"hitl",with:{mode:"approve",message:"go?"}}],edges:[{from:"START",to:"gate"},{from:"gate",to:"END"}],runtime:{checkpoint:{enabled:true,backend:"sqlite",path:"state.db"}}}));
    expect(cli("run","g.yaml","--thread","t","--on-interrupt","fail").status).toBe(3);
    const result=cli("recover","g.yaml","--thread","t");
    expect(result.status,result.stderr).toBe(0);
    const data=JSON.parse(result.stdout);
    expect(data).toMatchObject({threadId:"t",claim:null,media:[],replay:[]});
    expect(data.checkpoints.length).toBeGreaterThan(0);
    expect(data.checkpoints[0].id).toEqual(expect.any(String));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
it("PLAT-372: missing targeted media journal is a clear failure, without a stack trace",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-journal-missing-"));
  try {
    const result=spawnSync(process.execPath,[bin,"media","inspect","--thread","t","--workspace",dir,"--node","img","--fingerprint","0123456789abcdef"],{encoding:"utf8"});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No media journal");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
it("PLAT-366: inspect help omits mutation flags",()=>{
  for(const command of ["media","replay"]) {
    const result=spawnSync(process.execPath,[bin,command,"inspect","--help"],{encoding:"utf8"});
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("--owner-stopped");
    expect(result.stdout).not.toContain("--result");
  }
});
it("PLAT-369: review gates suggest a decision and forms direct callers to their schema",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-gate-hints-"));
  try {
    for(const mode of ["review","form"]) {
      writeFileSync(join(dir,"g.yaml"),JSON.stringify({apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"hints"},nodes:[{id:"gate",type:"hitl",with:{mode,message:"answer?",...(mode==="form"?{schema:{type:"object",properties:{name:{type:"string"}},required:["name"]}}:{})}}],edges:[{from:"START",to:"gate"},{from:"gate",to:"END"}]}));
      const result=spawnSync(process.execPath,[bin,"run","g.yaml","--on-interrupt","fail","--thread","hint"],{cwd:dir,encoding:"utf8",timeout:20000});
      expect(result.status,result.stderr).toBe(3);
      expect(result.stdout).toContain(mode==="review"?'"decision":"approve"':"--list");
      expect(result.stdout).toContain("not durable");
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it("PLAT-366: replay inspection omits historical shell output unless full detail is requested",()=>{
  const rows=[{task:'["node"]',entries:{shell:{identity:"x",result:{stdout:"historical-output",stderr:"",exitCode:0}},pending:{__fg:"PendingStep",id:"r",kind:"shell"}}}];
  expect(JSON.stringify(replayInspection(rows))).not.toContain("historical-output");
  expect(replayInspection(rows)[0]).toMatchObject({taskIdentity:["node"],completedSlots:["shell"],entries:{pending:{id:"r"}}});
  expect(JSON.stringify(replayInspection(rows,true))).toContain("historical-output");
});
