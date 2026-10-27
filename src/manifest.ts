import { readFileSync } from "node:fs";

export interface PrivateWireContract {
  sidekickToolCallMeta: string;
  sidekickToolCallIdPrefix: string;
  subagentContextMeta: string;
  subagentStartedMeta: string;
  subagentCompletedMeta: string;
  subagentSupportClientCapability: string;
  rootAgentId: string;
  sidekickAgentId: string;
  toolNameMeta: string;
  inferenceToolNameMeta: string;
  compactionNotificationMethod: string;
  compactionSessionIdField: string;
  compactionStatusField: string;
  compactionSummaryField: string;
  compactionStartedStatus: string;
  compactionCompletedStatus: string;
  compactionFailedStatus: string;
  compactionManualCommand: string;
  elicitationAllowOtherMeta: string;
  usageInputTokensMeta: string;
  usageOutputTokensMeta: string;
  usageCachedReadTokensMeta: string;
  usageCachedWriteTokensMeta: string;
  usageTotalCreditCostMeta: string;
  usageTotalAcuCostMeta: string;
  usageResponseDimensionsMeta: string;
  speedConfigId: string;
  speedFastValue: string;
  modelConfigCacheDir: string;
  modelConfigCachePrefix: string;
  modelConfigCacheSuffix: string;
  modelFamilyFastModeKey: string;
}

/** Field numbers of the `model_configs_v6.*.bin` protobuf payload. */
export interface ModelConfigCacheProtobuf {
  configs: number;
  modelUid: number;
  familyMetadata: number;
  familyLabel: number;
  entry: number;
  entryKey: number;
  entryValue: number;
  order: number;
  label: number;
  controlType: number;
  effortControlType: number;
}

const FIELDS: readonly (keyof PrivateWireContract)[] = [
  "sidekickToolCallMeta",
  "sidekickToolCallIdPrefix",
  "subagentContextMeta",
  "subagentStartedMeta",
  "subagentCompletedMeta",
  "subagentSupportClientCapability",
  "rootAgentId",
  "sidekickAgentId",
  "toolNameMeta",
  "inferenceToolNameMeta",
  "compactionNotificationMethod",
  "compactionSessionIdField",
  "compactionStatusField",
  "compactionSummaryField",
  "compactionStartedStatus",
  "compactionCompletedStatus",
  "compactionFailedStatus",
  "compactionManualCommand",
  "elicitationAllowOtherMeta",
  "usageInputTokensMeta",
  "usageOutputTokensMeta",
  "usageCachedReadTokensMeta",
  "usageCachedWriteTokensMeta",
  "usageTotalCreditCostMeta",
  "usageTotalAcuCostMeta",
  "usageResponseDimensionsMeta",
  "speedConfigId",
  "speedFastValue",
  "modelConfigCacheDir",
  "modelConfigCachePrefix",
  "modelConfigCacheSuffix",
  "modelFamilyFastModeKey",
];

const PROTOBUF_FIELDS: readonly (keyof ModelConfigCacheProtobuf)[] = [
  "configs",
  "modelUid",
  "familyMetadata",
  "familyLabel",
  "entry",
  "entryKey",
  "entryValue",
  "order",
  "label",
  "controlType",
  "effortControlType",
];

function loadPrivateWireContract(): PrivateWireContract {
  const raw = JSON.parse(
    readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const section = raw["privateWireContract"];
  if (
    typeof section !== "object" ||
    section === null ||
    Array.isArray(section)
  ) {
    throw new Error(
      "runtime-manifest.json: privateWireContract must be an object",
    );
  }
  const contract: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = (section as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value) {
      throw new Error(
        `runtime-manifest.json: privateWireContract.${field} must be a non-empty string`,
      );
    }
    contract[field] = value;
  }
  return contract as unknown as PrivateWireContract;
}

function loadModelConfigCacheProtobuf(): ModelConfigCacheProtobuf {
  const raw = JSON.parse(
    readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const section = raw["modelConfigCacheProtobuf"];
  if (
    typeof section !== "object" ||
    section === null ||
    Array.isArray(section)
  ) {
    throw new Error(
      "runtime-manifest.json: modelConfigCacheProtobuf must be an object",
    );
  }
  const fields: Record<string, number> = {};
  for (const field of PROTOBUF_FIELDS) {
    const value = (section as Record<string, unknown>)[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(
        `runtime-manifest.json: modelConfigCacheProtobuf.${field} must be a positive integer`,
      );
    }
    fields[field] = value;
  }
  return fields as unknown as ModelConfigCacheProtobuf;
}

export const privateWireContract = loadPrivateWireContract();
export const modelConfigCacheProtobuf = loadModelConfigCacheProtobuf();
