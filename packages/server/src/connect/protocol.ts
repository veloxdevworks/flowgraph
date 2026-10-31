export const CONNECT_PROTOCOL_VERSION = 1;

export type ConnectHello = {
  type: "hello";
  protocolVersion: number;
  token?: string;
  capabilities: string[];
};

export type ConnectHelloAck = {
  type: "hello.ack";
  protocolVersion: number;
  sessionId: string;
};

export type ConnectCommand = {
  type: "command";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type ConnectCommandResult = {
  type: "command.result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Machine-readable error code when the server refused the command (e.g. THREAD_NOT_OWNED). */
  code?: string;
};

export type ConnectEventBatch = {
  type: "event.batch";
  threadId: string;
  events: unknown[];
};

export type ConnectInbound = ConnectHelloAck | ConnectCommand;
export type ConnectOutbound = ConnectHello | ConnectCommandResult | ConnectEventBatch;

export function isHelloAck(msg: unknown): msg is ConnectHelloAck {
  return Boolean(
    msg &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === "hello.ack" &&
      typeof (msg as { protocolVersion?: unknown }).protocolVersion === "number",
  );
}

export function isCommand(msg: unknown): msg is ConnectCommand {
  return Boolean(
    msg &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === "command" &&
      typeof (msg as { id?: unknown }).id === "string" &&
      typeof (msg as { method?: unknown }).method === "string",
  );
}
