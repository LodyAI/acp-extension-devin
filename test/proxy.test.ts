import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DevinAcpProxy } from "../src/proxy.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};

const initializeResponse = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
  },
};

describe("DevinAcpProxy", () => {
  it("passes a client initialize request to the runtime and its response back", () => {
    const proxy = new DevinAcpProxy();

    expect(proxy.handleClient(initializeRequest)).toEqual({
      toClient: [],
      toRuntime: [initializeRequest],
    });
    expect(proxy.pendingClientMethod(1)).toBe("initialize");

    expect(proxy.handleRuntime(initializeResponse)).toEqual({
      toClient: [
        {
          ...initializeResponse,
          result: {
            ...initializeResponse.result,
            agentCapabilities: {
              ...initializeResponse.result.agentCapabilities,
              _meta: { lody: { subagentEvents: { version: 1 } } },
            },
          },
        },
      ],
      toRuntime: [],
    });
    expect(proxy.pendingClientMethod(1)).toBeUndefined();
  });

  it("forwards runtime session/update notifications to the client verbatim", () => {
    const proxy = new DevinAcpProxy();
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "devin-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    };

    expect(proxy.handleRuntime(update)).toEqual({
      toClient: [update],
      toRuntime: [],
    });
  });

  it("forwards session/new and session/load mcpServers verbatim, negotiated or not", () => {
    const mcpServers = [
      {
        type: "stdio",
        name: "probe-stdio",
        command: "/bin/probe",
        args: ["--serve"],
        env: [
          { name: "PROBE_FLAG", value: "1" },
          { name: "SECOND", value: "two" },
        ],
      },
      {
        type: "http",
        name: "probe-http",
        url: "http://127.0.0.1:8765/mcp",
        headers: [
          { name: "Authorization", value: "Bearer probe-token" },
          { name: "X-Probe", value: "1" },
        ],
      },
      {
        type: "sse",
        name: "probe-sse",
        url: "http://127.0.0.1:8766/sse",
        headers: [{ name: "X-Probe", value: "2" }],
      },
    ];

    for (const negotiated of [false, true]) {
      const proxy = new DevinAcpProxy();
      proxy.handleClient({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: negotiated
            ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
            : {},
        },
      });

      for (const method of ["session/new", "session/load"] as const) {
        const request =
          method === "session/new"
            ? {
                jsonrpc: "2.0",
                id: 2,
                method,
                params: { cwd: "/work", mcpServers },
              }
            : {
                jsonrpc: "2.0",
                id: 3,
                method,
                params: {
                  sessionId: "devin-session",
                  cwd: "/work",
                  mcpServers,
                },
              };
        const out = proxy.handleClient(request);
        expect(out.toClient).toEqual([]);
        expect(out.toRuntime).toHaveLength(1);
        expect((out.toRuntime[0] as typeof request).params.mcpServers).toEqual(
          mcpServers,
        );
      }
    }
  });

  it("passes runtime reverse requests and client responses through without touching pending", () => {
    const proxy = new DevinAcpProxy();

    const promptRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "devin-session", prompt: [] },
    };
    proxy.handleClient(promptRequest);
    expect(proxy.pendingClientMethod(7)).toBe("session/prompt");

    // Both directions own separate id spaces; a reverse request may reuse the id.
    const reverseRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "devin-session", options: [] },
    };
    expect(proxy.handleRuntime(reverseRequest)).toEqual({
      toClient: [reverseRequest],
      toRuntime: [],
    });

    const clientResponse = {
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    };
    expect(proxy.handleClient(clientResponse)).toEqual({
      toClient: [],
      toRuntime: [clientResponse],
    });
    expect(proxy.pendingClientMethod(7)).toBe("session/prompt");

    const promptResponse = {
      jsonrpc: "2.0",
      id: 7,
      result: { stopReason: "end_turn" },
    };
    expect(proxy.handleRuntime(promptResponse)).toEqual({
      toClient: [promptResponse],
      toRuntime: [],
    });
    expect(proxy.pendingClientMethod(7)).toBeUndefined();
  });
});

describe("runtime manifest", () => {
  const manifestPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "runtime-manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    officialRuntime: Record<string, string>;
    privateWireContract: Record<string, string>;
  };

  it("pins the official Devin runtime", () => {
    expect(manifest.officialRuntime).toEqual({
      package: "devin",
      version: "3000.11.3",
      minimumSupportedVersion: "3000.11.1",
    });
  });

  it("adapts the official runtime wire contract", () => {
    const contract = manifest.privateWireContract;
    expect(contract.sidekickToolCallMeta).toBe("cognition.ai/sidekick");
    expect(contract.sidekickToolCallIdPrefix).toBe("sk::");
    expect(contract.subagentContextMeta).toBe("cognition.ai/subagent_context");
    expect(contract.subagentStartedMeta).toBe("cognition.ai/subagent_started");
    expect(contract.subagentCompletedMeta).toBe(
      "cognition.ai/subagent_completed",
    );
    expect(contract.subagentSupportClientCapability).toBe(
      "cognition.ai/subagentSupport",
    );
    expect(contract.rootAgentId).toBe("root");
    expect(contract.sidekickAgentId).toBe("sidekick");
    expect(contract.toolNameMeta).toBe("cognition.ai/toolName");
    expect(contract.inferenceToolNameMeta).toBe(
      "cognition.ai/inferenceToolName",
    );
  });
});
