import { program } from "./commands.js";
program.parseAsync(process.argv).catch((err: unknown) => {
  const code=(err as {code?:string})?.code;
  const message=err instanceof Error ? err.message : String(err);
  console.error(code && !message.startsWith(code) ? `${code}: ${message}` : message);
  process.exit(1);
});
