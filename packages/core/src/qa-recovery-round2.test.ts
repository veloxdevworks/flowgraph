import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageLedger, emptyUsage } from "./usage/ledger.js";
import { createFileJournal, listMediaJournals, resolveMediaSubmission } from "./media/journal.js";
import { pendingStep, resolveThreadReplay } from "./providers/replay-persistence.js";
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
it("PLAT-366: identical usage recovery is idempotent; a conflicting amount is refused",async()=>{
  let record:any;
  const saver={readThreadUsage:()=>record,writeThreadUsage:(_t:string,r:any)=>{record=r;}};
  const {pendingCalls:_,...totals}=emptyUsage();
  await saver.writeThreadUsage("t",{version:1,totals,pending:{r:{nodeId:"n",kind:"media",startedAt:"now"}}});
  const ledger=await UsageLedger.open(saver,"t");
  await ledger.resolve("r",{costUSD:2});
  await ledger.resolve("r",{costUSD:2});
  expect(ledger.snapshot()).toMatchObject({costUSD:2,calls:1,pendingCalls:0});
  await expect(ledger.resolve("r",{costUSD:3})).rejects.toMatchObject({code:"USAGE_RESOLUTION_CONFLICT"});
});
it.each([{notApplied:true} as const,{result:{stdout:"done",stderr:"",exitCode:0}}])("PLAT-366: replay recovery can be retried without applying twice: %j",async resolution=>{
  const step=pendingStep("shell",{identity:"same"});
  const entries:Record<string,unknown>={slot:step};
  const saver={initializeThreadReplay:()=>{},readThreadReplay:()=>({...entries}),listThreadReplay:()=>[],compareThreadReplay:(_t:string,_task:string,key:string,expected:unknown,value:unknown)=>{
    if(JSON.stringify(entries[key])!==JSON.stringify(expected))return false;
    if(value===undefined)delete entries[key];else entries[key]=value;
    return true;
  }};
  await expect(resolveThreadReplay(saver,"t","task","slot",step.id,{result:"wrong shape"})).rejects.toThrow(/Recovered shell result/);
  await resolveThreadReplay(saver,"t","task","slot",step.id,resolution);
  await resolveThreadReplay(saver,"t","task","slot",step.id,resolution);
  await expect(resolveThreadReplay(saver,"t","task","slot",step.id,{result:{stdout:"different",stderr:"",exitCode:0}})).rejects.toMatchObject({code:"REPLAY_RESOLUTION_CONFLICT"});
});
it("PLAT-365/366: discovers media identities and persists idempotent resolution across journal reopen",async()=>{
  const workspace=await mkdtemp(join(tmpdir(),"fg-recovery-"));dirs.push(workspace);
  const options={workspace,scope:"t",nodeId:"fan[2]",fingerprint:"0123456789abcdef"};
  const journal=createFileJournal(options);
  await journal.write({version:1,state:"intent",provider:"vendor",submittedAt:"now",submissionId:"s",handle:{id:"s"}});
  expect(await listMediaJournals(workspace,"t")).toMatchObject([{nodeId:"fan[2]",fingerprint:options.fingerprint,submissionId:"s"}]);
  await resolveMediaSubmission(journal,"s",{notSubmitted:true});
  await resolveMediaSubmission(createFileJournal(options),"s",{notSubmitted:true});
  await expect(resolveMediaSubmission(journal,"s",{handle:{id:"job"}})).rejects.toMatchObject({code:"MEDIA_RESOLUTION_CONFLICT"});
  expect(await journal.read()).toBeUndefined();
  await journal.write({version:1,state:"intent",provider:"vendor",submittedAt:"later",submissionId:"new-submission",handle:{id:"new-submission"}});
  await expect(resolveMediaSubmission(journal,"s",{notSubmitted:true})).rejects.toMatchObject({code:"MEDIA_SUBMISSION_CHANGED"});
});
