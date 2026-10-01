import { randomUUID } from "node:crypto";

import {
  LODY_SUBAGENT_EVENT_METHOD,
  supportsLodySubagentEvents,
} from "acp-extension-core";

import { privateWireContract as contract } from "./manifest.js";
import {
  DevinSubagentEvents,
  type DevinSubagentEventsOptions,
  type SubagentOut,
} from "./subagents.js";

const SUBAGENT_SUPPORT_META = contract.subagentSupportClientCapability;
const SUBAGENT_EVENTS_CAPABILITY = { version: 1 } as const;
const COMPACTION_CAPABILITY = { version: 1 } as const;
const COMPACTION_ACTIVITY_META = {
  lody: { activity: { version: 1, kind: "context_compaction" } },
} as const;

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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface PendingRequest {
  method: string;
  sessionId?: string;
}

/**
 * ACP-to-ACP proxy between Lody (client) and `devin acp` (runtime).
 * For admitted root sessions it translates native compaction lifecycle
 * notifications into Core activities; subagent event translation additionally
 * requires bilateral negotiation. Other ACP traffic is forwarded unchanged.
 */
export class DevinAcpProxy {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly sessions = new Map<string, DevinSubagentEvents>();
  private readonly admitted = new Set<string>();
  /** sessions inside a session/load replay window: updates pass through. */
  private readonly replaying = new Set<string>();
  /** admitted sessions with a live native compaction, keyed tool call id. */
  private readonly activeCompactions = new Map<string, string>();
  private negotiated = false;
  private readonly subagentOpts: DevinSubagentEventsOptions;
  private readonly newId: () => string;

  constructor(opts: DevinSubagentEventsOptions = {}) {
    this.subagentOpts = opts;
    this.newId = opts.newId ?? randomUUID;
  }

  handleClient(message: unknown): ProxyOutput {
    let msg = message as JsonRpcMessage;
    if (!isRecord(msg)) return { toClient: [], toRuntime: [msg] };

    if (isRequest(msg)) {
      const sessionId =
        isRecord(msg.params) && typeof msg.params["sessionId"] === "string"
          ? msg.params["sessionId"]
          : undefined;
      this.pending.set(msg.id, { method: msg.method, sessionId });

      if (msg.method === "initialize") {
        const caps = isRecord(msg.params)
          ? msg.params["clientCapabilities"]
          : undefined;
        this.negotiated = supportsLodySubagentEvents(caps);
        if (this.negotiated && isRecord(msg.params)) {
          // ask the runtime for its private subagent stream
          msg = {
            ...msg,
            params: {
              ...msg.params,
              clientCapabilities: {
                ...(isRecord(caps) ? caps : {}),
                _meta: {
                  ...(isRecord(caps) && isRecord(caps["_meta"])
                    ? caps["_meta"]
                    : {}),
                  [SUBAGENT_SUPPORT_META]: true,
                },
              },
            },
          };
        }
      }

      if (
        (msg.method === "session/load" || msg.method === "session/resume") &&
        sessionId
      ) {
        this.replaying.add(sessionId);
      }
    }
    // Client responses to runtime reverse requests carry an id but no method;
    // they are forwarded verbatim and must not touch the pending map.
    return { toClient: [], toRuntime: [msg] };
  }

  handleRuntime(message: unknown): ProxyOutput {
    const msg = message as JsonRpcMessage;
    if (!isRecord(msg)) return { toClient: [msg], toRuntime: [] };

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return this.handleRuntimeResponse(msg, pending);
    }

    if (isRequest(msg)) {
      return this.handleRuntimeRequest(msg);
    }

    // notifications
    if (msg.method === "session/update" && isRecord(msg.params)) {
      return this.handleSessionUpdate(msg);
    }
    if (msg.method === contract.compactionNotificationMethod) {
      return this.handleCompactionNotification(msg);
    }
    return { toClient: [msg], toRuntime: [] };
  }

  private handleRuntimeResponse(
    msg: JsonRpcResponse,
    pending: PendingRequest | undefined,
  ): ProxyOutput {
    const toClient: JsonRpcMessage[] = [];

    if (pending?.method === "initialize" && isRecord(msg.result)) {
      const agentCaps = isRecord(msg.result["agentCapabilities"])
        ? msg.result["agentCapabilities"]
        : {};
      const meta = isRecord(agentCaps["_meta"]) ? agentCaps["_meta"] : {};
      const lody = isRecord(meta["lody"]) ? meta["lody"] : {};
      const result = {
        ...msg.result,
        agentCapabilities: {
          ...agentCaps,
          _meta: {
            ...meta,
            lody: {
              ...lody,
              subagentEvents: SUBAGENT_EVENTS_CAPABILITY,
              compaction: COMPACTION_CAPABILITY,
            },
          },
        },
      };
      toClient.push({ ...msg, result });
      return { toClient, toRuntime: [] };
    }

    if (
      pending?.method === "session/new" ||
      pending?.method === "session/fork"
    ) {
      if (isRecord(msg.result) && typeof msg.result["sessionId"] === "string") {
        this.admit(msg.result["sessionId"]);
      }
    } else if (
      (pending?.method === "session/load" ||
        pending?.method === "session/resume") &&
      pending.sessionId
    ) {
      this.replaying.delete(pending.sessionId);
      if (msg.result !== undefined && msg.error === undefined) {
        this.admit(pending.sessionId);
      }
    } else if (pending?.method === "session/prompt" && pending.sessionId) {
      const session = this.sessions.get(pending.sessionId);
      if (session) {
        const isError = msg.error !== undefined;
        const stopReason =
          isRecord(msg.result) && typeof msg.result["stopReason"] === "string"
            ? msg.result["stopReason"]
            : undefined;
        for (const o of session.handlePromptDone(stopReason, isError)) {
          toClient.push(...this.render(session, o));
        }
      }
    }

    toClient.push(msg);
    return { toClient, toRuntime: [] };
  }

  private handleRuntimeRequest(msg: JsonRpcRequest): ProxyOutput {
    if (msg.method === "session/request_permission" && isRecord(msg.params)) {
      const sessionId =
        typeof msg.params["sessionId"] === "string"
          ? msg.params["sessionId"]
          : undefined;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (
        session &&
        sessionId &&
        this.admitted.has(sessionId) &&
        !this.replaying.has(sessionId)
      ) {
        const rewritten = session.rewritePermissionParams(msg.params);
        if (rewritten) {
          const toClient: JsonRpcMessage[] = [];
          for (const o of rewritten.events) {
            toClient.push(...this.render(session, o));
          }
          toClient.push({ ...msg, params: rewritten.params });
          return { toClient, toRuntime: [] };
        }
      }
    }
    return { toClient: [msg], toRuntime: [] };
  }

  private handleSessionUpdate(msg: JsonRpcNotification): ProxyOutput {
    const params = msg.params as Record<string, unknown>;
    const sessionId =
      typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const update = params["update"];
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (
      !this.negotiated ||
      !sessionId ||
      !session ||
      !this.admitted.has(sessionId) ||
      this.replaying.has(sessionId) ||
      !isRecord(update)
    ) {
      return { toClient: [msg], toRuntime: [] };
    }
    const toClient: JsonRpcMessage[] = [];
    for (const o of session.handleSessionUpdate(update)) {
      toClient.push(...this.render(session, o));
    }
    return { toClient, toRuntime: [] };
  }

  /**
   * Devin's private `_cognition.ai/compaction` lifecycle, rendered as a Core
   * context-compaction activity on a synthetic tool call. The native lifecycle
   * owns completion independently of the `/compact` prompt response. Only
   * admitted sessions outside a replay window produce activity; replay and
   * malformed or unknown-status rows pass through untouched.
   */
  private handleCompactionNotification(msg: JsonRpcNotification): ProxyOutput {
    const params = msg.params;
    const sessionId =
      isRecord(params) &&
      typeof params[contract.compactionSessionIdField] === "string" &&
      params[contract.compactionSessionIdField]
        ? (params[contract.compactionSessionIdField] as string)
        : undefined;
    const status = isRecord(params)
      ? params[contract.compactionStatusField]
      : undefined;
    const known =
      status === contract.compactionStartedStatus ||
      status === contract.compactionCompletedStatus ||
      status === contract.compactionFailedStatus;
    if (
      !sessionId ||
      !known ||
      !this.admitted.has(sessionId) ||
      this.replaying.has(sessionId)
    ) {
      return { toClient: [msg], toRuntime: [] };
    }

    if (status === contract.compactionStartedStatus) {
      if (this.activeCompactions.has(sessionId)) {
        return { toClient: [], toRuntime: [] };
      }
      const toolCallId = `devin-compaction-${this.newId()}`;
      this.activeCompactions.set(sessionId, toolCallId);
      return {
        toClient: [
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: "Compact context",
                kind: "other",
                status: "in_progress",
                _meta: { ...COMPACTION_ACTIVITY_META },
              },
            },
          },
        ],
        toRuntime: [],
      };
    }

    const toolCallId = this.activeCompactions.get(sessionId);
    this.activeCompactions.delete(sessionId);
    if (!toolCallId) {
      return { toClient: [], toRuntime: [] };
    }
    const update: Record<string, unknown> = {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      _meta: { ...COMPACTION_ACTIVITY_META },
    };
    const summary = (params as Record<string, unknown>)[
      contract.compactionSummaryField
    ];
    if (
      status === contract.compactionCompletedStatus &&
      typeof summary === "string"
    ) {
      update["content"] = [
        { type: "content", content: { type: "text", text: summary } },
      ];
    }
    return {
      toClient: [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        },
      ],
      toRuntime: [],
    };
  }

  private render(
    session: DevinSubagentEvents,
    out: SubagentOut,
  ): JsonRpcMessage[] {
    if (out.kind === "event") {
      return [
        {
          jsonrpc: "2.0",
          method: LODY_SUBAGENT_EVENT_METHOD,
          params: out.event as unknown as Record<string, unknown>,
        },
      ];
    }
    return [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: session.sessionId, update: out.update },
      },
    ];
  }

  private admit(sessionId: string) {
    if (!this.admitted.has(sessionId)) {
      this.admitted.add(sessionId);
      this.sessions.set(
        sessionId,
        new DevinSubagentEvents(sessionId, this.subagentOpts),
      );
    }
  }

  /** Method of the still-pending client request, for translation dispatch. */
  pendingClientMethod(id: JsonRpcId): string | undefined {
    return this.pending.get(id)?.method;
  }
}
