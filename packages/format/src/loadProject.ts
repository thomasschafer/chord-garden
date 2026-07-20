import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticCollector, type Diagnostic, type Loc } from "./diagnostics.js";
import { parseStrictJson, type JsonObject, type JsonValue } from "./jsonParse.js";
import type {
  ArrangementDoc,
  AutomationDoc,
  InstrumentDoc,
  PatternDoc,
  Project,
  ProjectDoc,
  TrackDoc,
} from "./model.js";
import { schemaValidate } from "./schema.js";
import { semanticValidate } from "./semantic.js";
import type { DocKind } from "./serialize.js";

export const SUPPORTED_FORMAT = 1;

export interface LoadedFile {
  path: string;
  kind: DocKind;
  value: JsonValue;
  locs: Map<string, Loc>;
}

export interface LoadResult {
  /** Present when every file parsed and passed schema validation. */
  project?: Project;
  /** Successfully parsed files, keyed by project-relative path. */
  files: Map<string, LoadedFile>;
  diagnostics: Diagnostic[];
  ok: boolean;
}

const DOC_DIRS = ["tracks", "patterns", "instruments", "automation"] as const;

export function loadProject(root: string): LoadResult {
  const diags = new DiagnosticCollector();
  const files = new Map<string, LoadedFile>();

  const projectValue = loadFile(root, "project.json", "project", files, diags, { required: true });

  // A newer format version must be rejected before anything else is reported:
  // every other diagnostic could be a false alarm produced by rules from the
  // wrong format version.
  if (projectValue !== undefined) {
    const format = (projectValue as JsonObject)["format"];
    if (typeof format === "number" && Number.isInteger(format) && format > SUPPORTED_FORMAT) {
      return finish(diags, files, {
        severity: "error",
        code: "project.format-unsupported",
        file: "project.json",
        pointer: "/format",
        message: `project format ${format} is newer than the supported format ${SUPPORTED_FORMAT}; upgrade the tool instead of editing the project`,
        loc: files.get("project.json")?.locs.get("/format") ?? { line: 1, column: 1 },
      });
    }
  }

  for (const dir of DOC_DIRS) {
    for (const name of listJsonFiles(root, dir, diags)) {
      const path = `${dir}/${name}`;
      loadFile(root, path, kindForPath(dir), files, diags, { required: false });
    }
  }

  loadFile(root, "arrangement.json", "arrangement", files, diags, { required: true });

  if (diags.hasErrors()) {
    return { files, diagnostics: diags.sorted(), ok: false };
  }

  const project = buildProject(root, files);
  semanticValidate(project, files, diags);
  return { project, files, diagnostics: diags.sorted(), ok: !diags.hasErrors() };
}

function finish(diags: DiagnosticCollector, files: Map<string, LoadedFile>, extra: Diagnostic): LoadResult {
  diags.add(extra);
  return { files, diagnostics: diags.sorted(), ok: false };
}

function loadFile(
  root: string,
  path: string,
  kindHint: DocKind | "pattern" | "instrument",
  files: Map<string, LoadedFile>,
  diags: DiagnosticCollector,
  opts: { required: boolean },
): JsonValue | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    if (opts.required) {
      diags.add({
        severity: "error",
        code: "project.missing-file",
        file: path,
        message: `required file ${path} is missing`,
        loc: { line: 1, column: 1 },
      });
    }
    return undefined;
  }

  const parsed = parseStrictJson(text, path);
  diags.addAll(parsed.diagnostics);
  if (parsed.value === undefined) return undefined;

  checkNumbers(parsed.value, "", path, parsed.locs, diags);

  const kind = resolveKind(kindHint, parsed.value, path, parsed.locs, diags);
  if (kind === undefined) return parsed.value;

  diags.addAll(schemaValidate(parsed.value, kind, path, parsed.locs));
  checkFileNameMatchesId(path, kind, parsed.value, parsed.locs, diags);

  files.set(path, { path, kind, value: parsed.value, locs: parsed.locs });
  return parsed.value;
}

function kindForPath(dir: (typeof DOC_DIRS)[number]): DocKind | "pattern" | "instrument" {
  switch (dir) {
    case "tracks":
      return "track";
    case "patterns":
      return "pattern";
    case "instruments":
      return "instrument";
    case "automation":
      return "automation";
  }
}

function resolveKind(
  hint: DocKind | "pattern" | "instrument",
  value: JsonValue,
  path: string,
  locs: Map<string, Loc>,
  diags: DiagnosticCollector,
): DocKind | undefined {
  if (hint === "pattern") {
    const kind = (value as JsonObject)["kind"];
    if (kind === "grid") return "pattern.grid";
    if (kind === "notes") return "pattern.notes";
    diags.add({
      severity: "error",
      code: "pattern.unknown-kind",
      file: path,
      pointer: "/kind",
      message: `pattern kind must be "grid" or "notes", found ${JSON.stringify(kind)}`,
      loc: locs.get("/kind") ?? locs.get("") ?? { line: 1, column: 1 },
    });
    return undefined;
  }
  if (hint === "instrument") {
    const type = (value as JsonObject)["type"];
    if (type === "synth") return "instrument.synth";
    if (type === "drumkit") return "instrument.drumkit";
    diags.add({
      severity: "error",
      code: "instrument.unknown-type",
      file: path,
      pointer: "/type",
      message: `instrument type must be "synth" or "drumkit", found ${JSON.stringify(type)}`,
      loc: locs.get("/type") ?? locs.get("") ?? { line: 1, column: 1 },
    });
    return undefined;
  }
  return hint;
}

function checkFileNameMatchesId(
  path: string,
  kind: DocKind,
  value: JsonValue,
  locs: Map<string, Loc>,
  diags: DiagnosticCollector,
): void {
  if (kind === "project" || kind === "arrangement") return;
  const idField = kind === "automation" ? "track" : "id";
  const id = (value as JsonObject)[idField];
  const expected = path.slice(path.lastIndexOf("/") + 1, -".json".length);
  if (typeof id === "string" && id !== expected) {
    diags.add({
      severity: "error",
      code: "id.file-mismatch",
      file: path,
      pointer: `/${idField}`,
      message: `"${idField}" is "${id}" but the file name requires "${expected}"`,
      suggestion: `rename the file to ${id}.json or set "${idField}" to "${expected}"`,
      loc: locs.get(`/${idField}`) ?? { line: 1, column: 1 },
    });
  }
}

/** Enforces the no-floats rule for every number in a file. */
function checkNumbers(
  value: JsonValue,
  pointer: string,
  file: string,
  locs: Map<string, Loc>,
  diags: DiagnosticCollector,
): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      diags.add({
        severity: "error",
        code: "number.float",
        file,
        pointer,
        message: `found non-integer number ${value}; every persisted quantity is an integer in its declared unit (permille, ms, Hz, cents, dB×100, bpm×100, ticks)`,
        loc: locs.get(pointer) ?? { line: 1, column: 1 },
      });
    } else if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      diags.add({
        severity: "error",
        code: "number.unsafe",
        file,
        pointer,
        message: `number ${value} exceeds the safe integer range`,
        loc: locs.get(pointer) ?? { line: 1, column: 1 },
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNumbers(item, `${pointer}/${i}`, file, locs, diags));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      checkNumbers(item, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, file, locs, diags);
    }
  }
}

function listJsonFiles(root: string, dir: string, diags: DiagnosticCollector): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return [];
  }
  const jsonFiles: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.endsWith(".json")) {
      jsonFiles.push(entry);
    } else if (!entry.startsWith(".")) {
      diags.add({
        severity: "warning",
        code: "orphan.unknown-file",
        file: `${dir}/${entry}`,
        message: `unexpected non-JSON file in ${dir}/`,
        loc: { line: 1, column: 1 },
      });
    }
  }
  return jsonFiles;
}

function buildProject(root: string, files: Map<string, LoadedFile>): Project {
  const tracks = new Map<string, TrackDoc>();
  const instruments = new Map<string, InstrumentDoc>();
  const patterns = new Map<string, PatternDoc>();
  const automation = new Map<string, AutomationDoc>();
  let projectDoc: ProjectDoc | undefined;
  let arrangement: ArrangementDoc | undefined;

  for (const file of files.values()) {
    switch (file.kind) {
      case "project":
        projectDoc = file.value as unknown as ProjectDoc;
        break;
      case "arrangement":
        arrangement = file.value as unknown as ArrangementDoc;
        break;
      case "track": {
        const doc = file.value as unknown as TrackDoc;
        tracks.set(doc.id, doc);
        break;
      }
      case "instrument.synth":
      case "instrument.drumkit": {
        const doc = file.value as unknown as InstrumentDoc;
        instruments.set(doc.id, doc);
        break;
      }
      case "pattern.grid":
      case "pattern.notes": {
        const doc = file.value as unknown as PatternDoc;
        patterns.set(doc.id, doc);
        break;
      }
      case "automation": {
        const doc = file.value as unknown as AutomationDoc;
        automation.set(doc.track, doc);
        break;
      }
    }
  }

  if (projectDoc === undefined || arrangement === undefined) {
    throw new Error("buildProject called with missing project.json or arrangement.json");
  }

  return { root, project: projectDoc, tracks, instruments, patterns, arrangement, automation };
}
