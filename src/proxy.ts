export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ProxyOutput {
  toClient: JsonRpcMessage[];
  toRuntime: JsonRpcMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return (
    typeof (message as JsonRpcRequest).method === "string" &&
    (message as JsonRpcRequest).id !== undefined &&
    (message as JsonRpcRequest).id !== null
  );
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return (
    (message as JsonRpcResponse).id !== undefined &&
    (message as JsonRpcResponse).id !== null &&
    (message as JsonRpcRequest).method === undefined
  );
}

/**
 * Transparent ACP-to-ACP proxy between Lody (client) and `devin acp`
 * (runtime). The skeleton forwards everything verbatim; `pending` already
 * records client request id -> method so later translations can act on
 * "which request this response answers". Note both directions own separate
 * JSON-RPC id spaces, so runtime requests and runtime responses are never
 * recorded here.
 */
export class DevinAcpProxy {
  private readonly pending = new Map<JsonRpcId, string>();

  handleClient(message: unknown): ProxyOutput {
    const msg = message as JsonRpcMessage;
    if (isRecord(msg) && isRequest(msg)) {
      this.pending.set(msg.id, msg.method);
    }
    // Client responses to runtime reverse requests carry an id but no method;
    // they are forwarded verbatim and must not touch the pending map.
    return { toClient: [], toRuntime: [msg] };
  }

  handleRuntime(message: unknown): ProxyOutput {
    const msg = message as JsonRpcMessage;
    if (isRecord(msg) && isResponse(msg)) {
      this.pending.delete(msg.id);
    }
    return { toClient: [msg], toRuntime: [] };
  }

  /** Method of the still-pending client request, for translation dispatch. */
  pendingClientMethod(id: JsonRpcId): string | undefined {
    return this.pending.get(id);
  }
}
