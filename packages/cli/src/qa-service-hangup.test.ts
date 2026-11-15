import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
it.skipIf(process.platform === "win32").each(["running","webhook"])("SIGHUP cleans detached services while %s",async mode=>{
  const dir=mkdtempSync(join(tmpdir(),"fg-hangup-")),pidFile=join(dir,"service.pid");
  const graph={apiVersion:"flowgraph/v1",kind:"Graph",metadata:{name:"hangup"},nodes:[
    {id:"server",type:"service",with:{name:"server",command:process.execPath,args:["-e",`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); console.log('ready'); setInterval(()=>{},1000)`],ready:{log:"ready"},readyInterval:"10ms"}},
    mode==="running"?{id:"hold",type:"shell",with:{command:process.execPath,args:["-e","setTimeout(()=>{},30000)"]}}:{id:"hold",type:"wait",with:{mode:"webhook",webhook:true}},
  ],edges:[{from:"START",to:"server"},{from:"server",to:"hold"},{from:"hold",to:"END"}]};
  writeFileSync(join(dir,"g.yaml"),JSON.stringify(graph));
  const child=spawn(process.execPath,[resolve(import.meta.dirname,"../dist/bin.js"),"run","g.yaml","--thread","hup","--json"],{cwd:dir,detached:true,stdio:["ignore","pipe","pipe"]});
  let output="",stderr="",servicePid:number|undefined;
  child.stdout!.on("data",c=>{output+=c;});child.stderr!.on("data",c=>{stderr+=c;});
  const done=new Promise<number|null>((r,e)=>{child.once("close",r);child.once("error",e);});
  try {
    const until=Date.now()+15000;
    while(Date.now()<until && !(existsSync(pidFile)&&(mode==="running"?output.includes('"nodeId":"hold"'):output.includes('"interrupt.raised"'))))await new Promise(r=>setTimeout(r,25));
    expect(existsSync(pidFile),output+stderr).toBe(true);servicePid=Number(readFileSync(pidFile,"utf8"));
    if(mode==="webhook")expect(output,stderr).toContain('"interrupt.raised"');
    process.kill(-child.pid!,"SIGHUP");
    const exit=await Promise.race([done,new Promise(r=>setTimeout(()=>r("hung"),8000))]);
    expect(exit,output+stderr).toBe(130);
    expect(()=>process.kill(servicePid!,0)).toThrow();
  } finally {
    try{process.kill(-child.pid!,"SIGKILL");}catch{}
    if(servicePid)try{process.kill(-servicePid,"SIGKILL");}catch{}
    await done;rmSync(dir,{recursive:true,force:true});
  }
},30000);
