import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Diagnostic, Loc } from "./diagnostics.js";
import type { JsonValue } from "./jsonParse.js";
import type { DocKind } from "./serialize.js";

const SCHEMA_FILES: Record<DocKind, string> = {
  project: "project.schema.json",
  track: "track.schema.json",
  "instrument.synth": "instrument-synth.schema.json",
  "instrument.drumkit": "instrument-drumkit.schema.json",
  "pattern.grid": "pattern-grid.schema.json",
  "pattern.notes": "pattern-notes.schema.json",
  arrangement: "arrangement.schema.json",
  automation: "automation.schema.json",
};

const ajv = new Ajv2020.default({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map<DocKind, ValidateFunction>();

export function loadSchema(kind: DocKind): Record<string, unknown> {
  const url = new URL(`../schemas/${SCHEMA_FILES[kind]}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function validatorFor(kind: DocKind): ValidateFunction {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile(loadSchema(kind));
    validators.set(kind, validator);
  }
  return validator;
}

/**
 * Validates a parsed value against the JSON Schema for its document kind and
 * converts Ajv errors into structured diagnostics located via the parse-time
 * pointer map.
 */
export function schemaValidate(
  value: JsonValue,
  kind: DocKind,
  file: string,
  locs: Map<string, Loc>,
): Diagnostic[] {
  const validator = validatorFor(kind);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((err) => toDiagnostic(err, file, locs));
}

function toDiagnostic(err: ErrorObject, file: string, locs: Map<string, Loc>): Diagnostic {
  const pointer = err.instancePath;
  const loc = locs.get(pointer) ?? locs.get("");
  const diagnostic: Diagnostic = {
    severity: "error",
    code: `schema.${err.keyword}`,
    file,
    message: formatMessage(err),
    pointer,
  };
  if (loc) diagnostic.loc = loc;
  return diagnostic;
}

function formatMessage(err: ErrorObject): string {
  const where = err.instancePath === "" ? "document root" : err.instancePath;
  if (err.keyword === "unevaluatedProperties" || err.keyword === "additionalProperties") {
    const prop =
      (err.params as { unevaluatedProperty?: string; additionalProperty?: string }).unevaluatedProperty ??
      (err.params as { additionalProperty?: string }).additionalProperty;
    return `${where} has unknown field "${prop}"`;
  }
  return `${where} ${err.message ?? "is invalid"}`;
}
