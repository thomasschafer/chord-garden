import type { JsonObject, JsonValue } from "./jsonParse.js";
import type { DocKind } from "./serialize.js";

/**
 * What a file's location in the bundle says about its kind. `pattern` and
 * `instrument` are the two directories whose documents come in more than one
 * kind, so the file's own contents decide.
 */
export type DocKindHint = DocKind | "pattern" | "instrument";

/**
 * The kind hint implied by a project-relative path, or undefined if the path is
 * not part of the §4 bundle layout.
 *
 * Pure and path-only: the filesystem loader walks directories to find these
 * files, while the sidecar's write endpoint is handed a path and has to reach
 * the same conclusion about it. One function so they cannot disagree.
 */
export function docKindHintForPath(path: string): DocKindHint | undefined {
  if (path === "project.json") return "project";
  if (path === "arrangement.json") return "arrangement";
  const slash = path.indexOf("/");
  if (slash < 0 || !path.endsWith(".json")) return undefined;
  if (path.indexOf("/", slash + 1) >= 0) return undefined;
  switch (path.slice(0, slash)) {
    case "tracks":
      return "track";
    case "patterns":
      return "pattern";
    case "instruments":
      return "instrument";
    case "automation":
      return "automation";
    default:
      return undefined;
  }
}

/**
 * Narrow a hint to a concrete kind using the document's discriminant field, or
 * undefined when that field is missing or unrecognised. Callers that can report
 * diagnostics should do so; this stays quiet so it can be used where there is
 * no diagnostic collector.
 */
export function docKindFromHint(hint: DocKindHint, value: JsonValue): DocKind | undefined {
  if (hint === "pattern") {
    const kind = (value as JsonObject)["kind"];
    if (kind === "grid") return "pattern.grid";
    if (kind === "notes") return "pattern.notes";
    return undefined;
  }
  if (hint === "instrument") {
    const type = (value as JsonObject)["type"];
    if (type === "synth") return "instrument.synth";
    if (type === "drumkit") return "instrument.drumkit";
    return undefined;
  }
  return hint;
}
