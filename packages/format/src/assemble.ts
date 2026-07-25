import type { JsonValue } from "./jsonParse.js";
import type {
  ArrangementDoc,
  AutomationDoc,
  InstrumentDoc,
  PatternDoc,
  Project,
  ProjectDoc,
  TrackDoc,
} from "./model.js";
import type { DocKind } from "./serialize.js";

/** One parsed document, already classified by `kind`. */
export interface AssembledFile {
  kind: DocKind;
  value: JsonValue;
}

/**
 * Index parsed documents into a `Project`.
 *
 * Pure, and deliberately separate from `loadProject`: the filesystem loader is
 * one caller, and a browser that has fetched the same documents over HTTP is
 * another (PLAN.md §10 — the sidecar serves files, the app holds the model). The
 * documents must already have passed schema validation; this only sorts them.
 */
export function assembleProject(root: string, files: Iterable<AssembledFile>): Project {
  const tracks = new Map<string, TrackDoc>();
  const instruments = new Map<string, InstrumentDoc>();
  const patterns = new Map<string, PatternDoc>();
  const automation = new Map<string, AutomationDoc>();
  let projectDoc: ProjectDoc | undefined;
  let arrangement: ArrangementDoc | undefined;

  for (const file of files) {
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

  if (projectDoc === undefined) throw new Error("cannot assemble project: no project.json document was supplied");
  if (arrangement === undefined) throw new Error("cannot assemble project: no arrangement.json document was supplied");

  return { root, project: projectDoc, tracks, instruments, patterns, arrangement, automation };
}
