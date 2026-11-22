import { expect, it } from "vitest";
import { UsageLedger, emptyUsage } from "./usage/ledger.js";
import { pendingStep, resolveThreadReplay } from "./providers/replay-persistence.js";
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
