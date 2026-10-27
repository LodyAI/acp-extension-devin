import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DevinAcpProxy, type JsonRpcResponse } from "../src/proxy.js";

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

// --- minimal protobuf encoder for catalog fixtures --------------------------

const varint = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
const tag = (no: number, wire: number) => varint((no << 3) | wire);
const fVar = (no: number, value: number) =>
  Buffer.concat([tag(no, 0), varint(value)]);
const fStr = (no: number, value: string) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([tag(no, 2), varint(bytes.length), bytes]);
};
const fMsg = (no: number, msg: Buffer) =>
  Buffer.concat([tag(no, 2), varint(msg.length), msg]);
const fLen = (no: number, wire: number, len: number) =>
  Buffer.concat([tag(no, wire), Buffer.alloc(len)]);

interface AxisSpec {
  key: string;
  order?: number;
  label?: string;
  controlType?: number;
}

const axisValue = ({ order, label, controlType }: AxisSpec) =>
  Buffer.concat([
    ...(order !== undefined ? [fVar(1, order)] : []),
    ...(label !== undefined ? [fStr(2, label)] : []),
    ...(controlType !== undefined ? [fVar(3, controlType)] : []),
  ]);
const axis = (spec: AxisSpec) =>
  Buffer.concat([fStr(1, spec.key), fMsg(2, axisValue(spec))]);
const modelConfig = (uid: string, family?: string, axes: AxisSpec[] = []) =>
  Buffer.concat([
    fStr(22, uid),
    ...(family !== undefined
      ? [
          fMsg(
            30,
            Buffer.concat([
              fStr(1, family),
              ...axes.map((a) => fMsg(2, axis(a))),
            ]),
          ),
        ]
      : []),
  ]);
const catalogFile = (configs: Buffer[]) =>
  JSON.stringify({
    version: 1,
    identity_digest: "probe",
    fetched_at_secs: 0,
    payload: Buffer.concat(configs.map((c) => fMsg(1, c))).toString("base64"),
  });

const writeCatalog = (
  dir: string,
  name: string,
  content: string | Buffer,
  mtimeMs: number,
) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
  return path;
};

// --- fixtures ---------------------------------------------------------------

// Family Eff: effort ladder low/medium/high; mdl-medium also has a fast twin.
// Family Think: "No Thinking" label maps to "none"; no Fast Mode axis at all.
// Family Fusion: Lead/Sidekick axes isolate effort ladders per sidekick.
const catalogModels = [
  modelConfig("mdl-low", "Eff", [
    { key: "Effort", order: 0, label: "Low", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("mdl-medium", "Eff", [
    { key: "Effort", order: 1, label: "Medium", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("mdl-medium-fast", "Eff", [
    { key: "Effort", order: 1, label: "Medium", controlType: 1 },
    { key: "Fast Mode", order: 1, controlType: 2 },
  ]),
  modelConfig("mdl-high", "Eff", [
    { key: "Effort", order: 2, label: "High", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("think-none", "Think", [
    { key: "Effort", order: 0, label: "No Thinking", controlType: 1 },
  ]),
  modelConfig("think-low", "Think", [
    { key: "Effort", order: 1, label: "Low", controlType: 1 },
  ]),
  modelConfig("solo", "Solo", [
    { key: "Effort", order: 0, label: "Solo", controlType: 1 },
  ]),
  modelConfig("orphan"),
  modelConfig("fus-a-low", "Fusion", [
    { key: "Lead", order: 0, label: "L", controlType: 3 },
    { key: "Sidekick", order: 0, label: "SK-A", controlType: 3 },
    { key: "Effort", order: 0, label: "Low", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("fus-a-high", "Fusion", [
    { key: "Lead", order: 0, label: "L", controlType: 3 },
    { key: "Sidekick", order: 0, label: "SK-A", controlType: 3 },
    { key: "Effort", order: 1, label: "High", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("fus-a-low-fast", "Fusion", [
    { key: "Lead", order: 0, label: "L", controlType: 3 },
    { key: "Sidekick", order: 0, label: "SK-A", controlType: 3 },
    { key: "Effort", order: 0, label: "Low", controlType: 1 },
    { key: "Fast Mode", order: 1, controlType: 2 },
  ]),
  modelConfig("fus-b-eco", "Fusion", [
    { key: "Lead", order: 0, label: "L", controlType: 3 },
    { key: "Sidekick", order: 1, label: "SK-B", controlType: 3 },
    { key: "Effort", order: 0, label: "Eco", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
  modelConfig("fus-b-turbo", "Fusion", [
    { key: "Lead", order: 0, label: "L", controlType: 3 },
    { key: "Sidekick", order: 1, label: "SK-B", controlType: 3 },
    { key: "Effort", order: 1, label: "Turbo", controlType: 1 },
    { key: "Fast Mode", order: 0, controlType: 2 },
  ]),
];

const modelUids = [
  "mdl-low",
  "mdl-medium",
  "mdl-medium-fast",
  "mdl-high",
  "think-none",
  "think-low",
  "solo",
  "orphan",
  "fus-a-low",
  "fus-a-high",
  "fus-a-low-fast",
  "fus-b-eco",
  "fus-b-turbo",
];

const leaf = (value: string) => ({ value, name: value });
const modelSelect = (current: string, values: string[], grouped = false) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: current,
  options: grouped
    ? [
        leaf(values[0] as string),
        { group: "g", name: "G", options: values.slice(1).map(leaf) },
      ]
    : values.map(leaf),
});
const thoughtSelect = (current: string, values: string[]) => ({
  id: "thought_level",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: current,
  options: values.map(leaf),
});
const speedSelect = (current = "standard") => ({
  id: "speed",
  name: "Speed",
  category: "model_config",
  type: "select",
  currentValue: current,
  options: [leaf("standard"), leaf("fast")],
});

// response for current model mdl-medium: ladder [low,medium,high], fast on
const sessionResult = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  configOptions: [
    modelSelect("mdl-medium", modelUids, true),
    thoughtSelect("medium", ["low", "medium", "high"]),
    speedSelect(),
  ],
  _meta: { "cognition.ai/isLocked": false },
  ...overrides,
});

const declaration = (result: unknown) =>
  (result as Record<string, Record<string, Record<string, unknown>>>)[
    "_meta"
  ]?.["lody"]?.["modelCapabilities"] as
    { version: number; models: Record<string, unknown> } | undefined;

describe("model capabilities from the catalog cache", () => {
  let next = 0;
  beforeEach(() => {
    next = 0;
  });
  const dir = () => mkdtempSync(join(tmpdir(), "acp-mc-"));
  const newProxy = (catalogDir: string) =>
    new DevinAcpProxy({ newId: () => `id-${++next}`, catalogDir });
  const initialize = (proxy: DevinAcpProxy) => {
    proxy.handleClient(initializeRequest);
    proxy.handleRuntime(initializeResponse);
  };
  const respond = (
    proxy: DevinAcpProxy,
    id: number,
    method: string,
    params: Record<string, unknown>,
    result: unknown,
  ) => {
    proxy.handleClient({ jsonrpc: "2.0", id, method, params });
    return proxy.handleRuntime({ jsonrpc: "2.0", id, result });
  };

  it("derives every option model's controls and merges the declaration", () => {
    const catalogDir = dir();
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      catalogFile(catalogModels),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);

    const response = sessionResult();
    const out = respond(
      proxy,
      2,
      "session/new",
      { cwd: "/w", mcpServers: [] },
      response,
    );
    expect(out.toRuntime).toEqual([]);
    expect(out.toClient).toHaveLength(1);
    const released = out.toClient[0] as JsonRpcResponse;
    expect(released.id).toBe(2);
    const caps = declaration(released.result);
    expect(caps?.version).toBe(1);
    expect(caps?.models).toEqual({
      "mdl-low": { effortValues: ["low", "medium", "high"], fastMode: false },
      "mdl-medium": { effortValues: ["low", "medium", "high"], fastMode: true },
      "mdl-medium-fast": { effortValues: [], fastMode: true },
      "mdl-high": { effortValues: ["low", "medium", "high"], fastMode: false },
      "think-none": { effortValues: ["none", "low"], fastMode: false },
      "think-low": { effortValues: ["none", "low"], fastMode: false },
      solo: { effortValues: [], fastMode: false },
      orphan: { effortValues: [], fastMode: false },
      "fus-a-low": { effortValues: ["low", "high"], fastMode: true },
      "fus-a-high": { effortValues: ["low", "high"], fastMode: false },
      "fus-a-low-fast": { effortValues: [], fastMode: true },
      "fus-b-eco": { effortValues: ["eco", "turbo"], fastMode: false },
      "fus-b-turbo": { effortValues: ["eco", "turbo"], fastMode: false },
    });
    // native _meta keys survive the merge
    expect(
      (released.result as Record<string, Record<string, unknown>>)["_meta"],
    ).toMatchObject({ "cognition.ai/isLocked": false });
  });

  it("uses the newest file that covers the whole select, skipping non-covering ones", () => {
    const catalogDir = dir();
    // newer file covers only the Fusion uids — it must be skipped
    writeCatalog(
      catalogDir,
      "model_configs_v6.bbbbbbbbbbbbbbbb.bin",
      catalogFile(catalogModels.slice(8)),
      2000,
    );
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      catalogFile(catalogModels),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);
    const out = respond(
      proxy,
      2,
      "session/new",
      { cwd: "/w", mcpServers: [] },
      sessionResult(),
    );
    const caps = declaration((out.toClient[0] as JsonRpcResponse).result);
    expect(caps?.models["mdl-medium"]).toEqual({
      effortValues: ["low", "medium", "high"],
      fastMode: true,
    });
    expect(Object.keys(caps?.models ?? {})).toHaveLength(modelUids.length);
  });

  it("annotates load, resume and fork responses the same way", () => {
    const catalogDir = dir();
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      catalogFile(catalogModels),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);
    let id = 10;
    for (const method of ["session/load", "session/resume", "session/fork"]) {
      const out = respond(
        proxy,
        id++,
        method,
        { sessionId: "s1", cwd: "/w", mcpServers: [] },
        sessionResult(),
      );
      expect(out.toRuntime).toEqual([]);
      const caps = declaration((out.toClient[0] as JsonRpcResponse).result);
      expect(caps?.version).toBe(1);
      expect(caps?.models["think-none"]).toEqual({
        effortValues: ["none", "low"],
        fastMode: false,
      });
    }
  });

  it("publishes nothing when the derived controls contradict the response", () => {
    const catalogDir = dir();
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      catalogFile(catalogModels),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // response claims a different ladder than the derivation produces
      const response = sessionResult({
        configOptions: [
          modelSelect("mdl-medium", modelUids),
          thoughtSelect("medium", ["low", "medium"]),
          speedSelect(),
        ],
      });
      const out = respond(
        proxy,
        2,
        "session/new",
        { cwd: "/w", mcpServers: [] },
        response,
      );
      expect(out.toRuntime).toEqual([]);
      expect(out.toClient[0]).toMatchObject({ id: 2, result: response });
      expect(
        declaration((out.toClient[0] as JsonRpcResponse).result),
      ).toBeUndefined();
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("forwards unchanged when no file covers the select or the file is corrupt", () => {
    const catalogDir = dir();
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      "not json at all",
      1000,
    );
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const proxy = newProxy(catalogDir);
      initialize(proxy);
      const response = sessionResult();
      const out = respond(
        proxy,
        2,
        "session/new",
        { cwd: "/w", mcpServers: [] },
        response,
      );
      expect(out.toRuntime).toEqual([]);
      expect(out.toClient[0]).toMatchObject({ id: 2, result: response });
      expect(
        declaration((out.toClient[0] as JsonRpcResponse).result),
      ).toBeUndefined();

      // a covering file appearing later still declares on the next response
      writeCatalog(
        catalogDir,
        "model_configs_v6.cccccccccccccccc.bin",
        catalogFile(catalogModels),
        3000,
      );
      const out2 = respond(
        proxy,
        3,
        "session/new",
        { cwd: "/w", mcpServers: [] },
        sessionResult({ sessionId: "s2" }),
      );
      expect(
        declaration((out2.toClient[0] as JsonRpcResponse).result)?.version,
      ).toBe(1);
      // at most one diagnostic line ever reached stderr
      const catalogLogs = stderr.mock.calls.filter((args) =>
        String(args[0]).includes("model catalog"),
      );
      expect(catalogLogs.length).toBeLessThanOrEqual(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("skips a corrupt newest file and falls back to an older covering one", () => {
    const catalogDir = dir();
    writeCatalog(
      catalogDir,
      "model_configs_v6.bbbbbbbbbbbbbbbb.bin",
      Buffer.from([0xff, 0xff, 0xff]),
      2000,
    );
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      catalogFile(catalogModels),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);
    const out = respond(
      proxy,
      2,
      "session/new",
      { cwd: "/w", mcpServers: [] },
      sessionResult(),
    );
    expect(
      declaration((out.toClient[0] as JsonRpcResponse).result)?.version,
    ).toBe(1);
  });

  it("skips unknown protobuf fields and wire types", () => {
    const catalogDir = dir();
    const noisy = Buffer.concat([
      fVar(99, 7), // unknown varint field
      fLen(40, 1, 8), // unknown fixed64
      fLen(41, 5, 4), // unknown fixed32
      fMsg(
        1,
        Buffer.concat([
          fStr(22, "mdl-medium"),
          fLen(7, 1, 8),
          fVar(6, 42),
          fMsg(
            30,
            Buffer.concat([
              fStr(1, "Eff"),
              fLen(9, 5, 4),
              fMsg(
                2,
                Buffer.concat([
                  fStr(1, "Effort"),
                  fMsg(
                    2,
                    axisValue({ order: 1, label: "Medium", controlType: 1 }),
                  ),
                ]),
              ),
              fMsg(
                2,
                Buffer.concat([
                  fStr(1, "Fast Mode"),
                  fMsg(2, axisValue({ order: 0, controlType: 2 })),
                ]),
              ),
            ]),
          ),
        ]),
      ),
      fMsg(
        1,
        modelConfig("mdl-low", "Eff", [
          { key: "Effort", order: 0, label: "Low", controlType: 1 },
          { key: "Fast Mode", order: 0, controlType: 2 },
        ]),
      ),
      fMsg(
        1,
        modelConfig("mdl-high", "Eff", [
          { key: "Effort", order: 2, label: "High", controlType: 1 },
          { key: "Fast Mode", order: 0, controlType: 2 },
        ]),
      ),
      fMsg(
        1,
        modelConfig("mdl-medium-fast", "Eff", [
          { key: "Effort", order: 1, label: "Medium", controlType: 1 },
          { key: "Fast Mode", order: 1, controlType: 2 },
        ]),
      ),
    ]);
    writeCatalog(
      catalogDir,
      "model_configs_v6.aaaaaaaaaaaaaaaa.bin",
      JSON.stringify({ payload: noisy.toString("base64") }),
      1000,
    );
    const proxy = newProxy(catalogDir);
    initialize(proxy);
    const response = sessionResult({
      configOptions: [
        modelSelect("mdl-medium", ["mdl-low", "mdl-medium", "mdl-high"]),
        thoughtSelect("medium", ["low", "medium", "high"]),
        speedSelect(),
      ],
    });
    const out = respond(
      proxy,
      2,
      "session/new",
      { cwd: "/w", mcpServers: [] },
      response,
    );
    const caps = declaration((out.toClient[0] as JsonRpcResponse).result);
    expect(caps?.models).toEqual({
      "mdl-low": { effortValues: ["low", "medium", "high"], fastMode: false },
      "mdl-medium": { effortValues: ["low", "medium", "high"], fastMode: true },
      "mdl-high": { effortValues: ["low", "medium", "high"], fastMode: false },
    });
  });

  it("leaves responses without a model select untouched", () => {
    const proxy = newProxy(dir());
    initialize(proxy);
    const result = { sessionId: "s1", configOptions: [] };
    const out = respond(
      proxy,
      2,
      "session/new",
      { cwd: "/w", mcpServers: [] },
      result,
    );
    expect(out).toEqual({
      toClient: [{ jsonrpc: "2.0", id: 2, result }],
      toRuntime: [],
    });
  });
});
