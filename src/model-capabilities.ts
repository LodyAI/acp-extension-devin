import { privateWireContract as contract } from "./manifest.js";

/** Core `_meta.lody.modelCapabilities` v1 controls for one model. */
export interface AcpModelControls {
  effortValues?: string[];
  fastMode?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flattened values of a select option; grouped entries contribute their
 * children's values in order. */
export function optionValues(option: Record<string, unknown>): string[] {
  const options = option["options"];
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const entry of options) {
    if (!isRecord(entry)) continue;
    const children = entry["options"];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (isRecord(child) && typeof child["value"] === "string") {
          values.push(child["value"]);
        }
      }
    } else if (typeof entry["value"] === "string") {
      values.push(entry["value"]);
    }
  }
  return values;
}

export function findConfigOption(
  configOptions: unknown,
  match: (option: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (isRecord(option) && match(option)) return option;
  }
  return undefined;
}

/** The `model` select in a session-establishment result's configOptions, when
 * the runtime describes one. */
export function sessionModelOption(
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return findConfigOption(
    result["configOptions"],
    (option) => option["id"] === "model" && option["type"] === "select",
  );
}

/**
 * Controls a session response actually reports for `requested`: the
 * `thought_level` option's ladder (`[]` when the option is absent) and whether
 * a `speed` option offers the fast value. Undefined when the response does
 * not report the requested model as current.
 */
export function modelControls(
  configOptions: unknown,
  requested: string,
): AcpModelControls | undefined {
  const model = findConfigOption(
    configOptions,
    (option) => option["id"] === "model",
  );
  if (!model || model["currentValue"] !== requested) return undefined;
  const thought = findConfigOption(
    configOptions,
    (option) => option["category"] === "thought_level",
  );
  const speed = findConfigOption(
    configOptions,
    (option) => option["id"] === contract.speedConfigId,
  );
  return {
    effortValues: thought ? optionValues(thought) : [],
    fastMode: speed
      ? optionValues(speed).includes(contract.speedFastValue)
      : false,
  };
}

/** The session result with the declaration merged under `_meta.lody`;
 * native `_meta` keys are preserved. */
export function withModelCapabilities(
  result: Record<string, unknown>,
  models: Record<string, AcpModelControls>,
): Record<string, unknown> {
  const meta = isRecord(result["_meta"]) ? result["_meta"] : {};
  const lody = isRecord(meta["lody"]) ? meta["lody"] : {};
  return {
    ...result,
    _meta: {
      ...meta,
      lody: { ...lody, modelCapabilities: { version: 1, models } },
    },
  };
}
