/** Preserve typed error codes across event and CLI transport boundaries. */
export function errorInfo(error: unknown, fallback = "RUN_ERROR"): {message:string;error:string;code:string} {
  const row=error && typeof error === "object" ? error as {message?:unknown;code?:unknown;lc_error_code?:unknown;cause?:unknown} : undefined;
  const message=(typeof row?.message === "string" ? row.message : String(error)).replace(/^(?:Error:\s*)+/,"");
  const code=typeof row?.code === "string" ? row.code : typeof row?.lc_error_code === "string" ? row.lc_error_code : fallback;
  return {message,error:message,code};
}
