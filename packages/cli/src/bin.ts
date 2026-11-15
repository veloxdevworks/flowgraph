import { randomUUID } from "node:crypto";
import { program } from "./commands.js";
const json=process.argv.includes("--json");
if(json) {
  const override=(command: import("commander").Command):void=>{
    command.exitOverride();
    command.configureOutput({writeErr:()=>{}});
    for(const child of command.commands)override(child);
  };
  override(program);
}
program.parseAsync(process.argv).catch(async (err: unknown) => {
  const row=err as {code?:string;exitCode?:number};
  if(row.exitCode===0)return;
  const code=row.code?.startsWith("commander.")?"CLI_ARGUMENT_INVALID":row.code??"CLI_ERROR";
  const message=(err instanceof Error?err.message:String(err)).replace(/^(?:Error:\s*)+/,"");
  if(json) console.log(JSON.stringify({id:randomUUID(),type:"run.error",ts:new Date().toISOString(),runId:"cli",graph:"cli",scope:{},seq:1,...(process.argv.includes("--thread")?{threadId:process.argv[process.argv.indexOf("--thread")+1]}:{}),data:{code,message,error:message,phase:"admission"}}));
  console.error(message.startsWith(code)?message:`${code}: ${message}`);
  await Promise.all([new Promise<void>(resolve=>process.stdout.write("",()=>resolve())),new Promise<void>(resolve=>process.stderr.write("",()=>resolve()))]);
  process.exit(row.exitCode??1);
});
