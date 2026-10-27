import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  modelConfigCacheProtobuf as proto,
  privateWireContract as contract,
} from "./manifest.js";
import type { AcpModelControls } from "./model-capabilities.js";

/** One control-axis entry of a family variant: the label of this variant's
 * setting on that axis plus its order in the axis ladder. */
interface CatalogEntry {
  order: number;
  label?: string;
  controlType?: number;
}

/** A model's family variant: the family label and its setting per axis key. */
interface CatalogVariant {
  family?: string;
  axes: Map<string, CatalogEntry>;
}

/** model_uid -> family variant, decoded from one catalog cache file. */
export type ModelCatalog = Map<string, CatalogVariant>;

interface ParsedFile {
  mtimeMs: number;
  size: number;
  catalog: ModelCatalog;
}

/** Per-process memo of parsed cache files, invalidated on mtime/size change. */
export type CatalogFileMemo = Map<string, ParsedFile>;

/** Devin's model catalog cache directory: `$XDG_CACHE_HOME` or `~/.cache`
 * plus the pinned `devin/cli` tail. */
export function defaultModelConfigCacheDir(): string {
  const base = process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache");
  return join(base, contract.modelConfigCacheDir);
}

// --- minimal protobuf wire reader ------------------------------------------

function readVarint(
  buf: Uint8Array,
  pos: number,
): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const byte = buf[pos++] as number;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [value, pos];
    if (shift > 70) throw new Error("overlong varint");
  }
}

interface WireField {
  no: number;
  varint?: number;
  bytes?: Uint8Array;
}

/** Iterate top-level fields; unknown fields and wire types 0/1/2/5 are
 * skipped, anything else makes the buffer unparseable. */
function* fields(buf: Uint8Array): Generator<WireField> {
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const no = key >> 3;
    const wire = key & 7;
    if (no === 0) throw new Error("protobuf field 0");
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      pos = next;
      yield { no, varint: value };
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos);
      pos = afterLen;
      if (pos + len > buf.length) throw new Error("truncated field");
      yield { no, bytes: buf.subarray(pos, pos + len) };
      pos += len;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error("truncated field");
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parseFamilyEntry(
  buf: Uint8Array,
): { key: string; value: CatalogEntry } | undefined {
  let key: string | undefined;
  const value: CatalogEntry = { order: 0 };
  for (const field of fields(buf)) {
    if (field.no === proto.entryKey && field.bytes !== undefined) {
      key = text(field.bytes);
    } else if (field.no === proto.entryValue && field.bytes !== undefined) {
      for (const inner of fields(field.bytes)) {
        if (inner.no === proto.order && inner.varint !== undefined) {
          value.order = inner.varint;
        } else if (inner.no === proto.label && inner.bytes !== undefined) {
          value.label = text(inner.bytes);
        } else if (
          inner.no === proto.controlType &&
          inner.varint !== undefined
        ) {
          value.controlType = inner.varint;
        }
      }
    }
  }
  return key === undefined ? undefined : { key, value };
}

/** Decode the base64 protobuf payload of a `model_configs_v6` cache file. */
export function parseCatalogPayload(payload: Uint8Array): ModelCatalog {
  const catalog: ModelCatalog = new Map();
  for (const field of fields(payload)) {
    if (field.no !== proto.configs || field.bytes === undefined) continue;
    let uid: string | undefined;
    const variant: CatalogVariant = { axes: new Map() };
    for (const config of fields(field.bytes)) {
      if (config.no === proto.modelUid && config.bytes !== undefined) {
        uid = text(config.bytes);
      } else if (
        config.no === proto.familyMetadata &&
        config.bytes !== undefined
      ) {
        for (const meta of fields(config.bytes)) {
          if (meta.no === proto.familyLabel && meta.bytes !== undefined) {
            variant.family = text(meta.bytes);
          } else if (meta.no === proto.entry && meta.bytes !== undefined) {
            const entry = parseFamilyEntry(meta.bytes);
            if (entry) variant.axes.set(entry.key, entry.value);
          }
        }
      }
    }
    if (uid !== undefined) catalog.set(uid, variant);
  }
  return catalog;
}

/** Parse one cache file's JSON envelope `{payload: base64 protobuf}`. */
export function parseCatalogFile(content: string): ModelCatalog {
  const doc = JSON.parse(content) as { payload?: unknown };
  if (typeof doc.payload !== "string") {
    throw new Error("catalog file has no string payload");
  }
  return parseCatalogPayload(Buffer.from(doc.payload, "base64"));
}

/**
 * Newest `model_configs_v6.*.bin` file in `dir` whose model_uids cover every
 * requested id, or undefined when the directory is unreadable or no file
 * covers them all. Parsed files are memoized by path + mtime + size.
 */
export function loadCoveringCatalog(
  dir: string,
  ids: string[],
  memo: CatalogFileMemo,
): ModelCatalog | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    if (
      !name.startsWith(contract.modelConfigCachePrefix) ||
      !name.endsWith(contract.modelConfigCacheSuffix)
    ) {
      continue;
    }
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) {
        candidates.push({
          path: join(dir, name),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of candidates) {
    let parsed = memo.get(file.path);
    if (
      parsed === undefined ||
      parsed.mtimeMs !== file.mtimeMs ||
      parsed.size !== file.size
    ) {
      try {
        parsed = {
          mtimeMs: file.mtimeMs,
          size: file.size,
          catalog: parseCatalogFile(readFileSync(file.path, "utf8")),
        };
      } catch {
        continue;
      }
      memo.set(file.path, parsed);
    }
    if (ids.every((id) => parsed.catalog.has(id))) return parsed.catalog;
  }
  return undefined;
}

// --- control derivation -----------------------------------------------------

function effortValueId(label: string): string {
  return label === "No Thinking" ? "none" : label.toLowerCase();
}

/** Orders match on every sibling axis except the given skipped keys. */
function sameOrders(
  sibling: CatalogVariant,
  mine: CatalogVariant,
  skip: (key: string, entry: CatalogEntry) => boolean,
): boolean {
  for (const [key, entry] of sibling.axes) {
    if (skip(key, entry)) continue;
    const own = mine.axes.get(key);
    if (own === undefined || own.order !== entry.order) return false;
  }
  return true;
}

/**
 * Derive one ACP model's controls from its family variants: siblings are the
 * catalog configs sharing the model's family label. `effortValues` is the
 * sorted ladder of effort-axis labels over siblings that differ from the
 * model only on the effort axis (`[]` below two levels); `fastMode` is true
 * when a sibling differs only on the `Fast Mode` axis and orders it fast.
 */
export function deriveControls(
  catalog: ModelCatalog,
  uid: string,
): AcpModelControls {
  const variant = catalog.get(uid);
  if (variant?.family === undefined) {
    return { effortValues: [], fastMode: false };
  }
  const siblings = [...catalog.values()].filter(
    (v) => v.family === variant.family,
  );
  const isEffort = (_key: string, entry: CatalogEntry) =>
    entry.controlType === proto.effortControlType;

  const levels = new Map<string, [order: number, label: string]>();
  for (const sibling of siblings) {
    if (!sameOrders(sibling, variant, isEffort)) continue;
    for (const [, entry] of sibling.axes) {
      if (entry.controlType === proto.effortControlType) {
        const key = `${entry.order}\n${entry.label ?? ""}`;
        levels.set(key, [entry.order, entry.label ?? ""]);
      }
    }
  }
  const sorted = [...levels.values()].sort(
    (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
  );
  const effortValues =
    sorted.length >= 2 ? sorted.map(([, label]) => effortValueId(label)) : [];

  const fastMode = siblings.some((sibling) => {
    const fast = sibling.axes.get(contract.modelFamilyFastModeKey);
    return (
      fast !== undefined &&
      fast.order === 1 &&
      sameOrders(
        sibling,
        variant,
        (key) => key === contract.modelFamilyFastModeKey,
      )
    );
  });
  return { effortValues, fastMode };
}
