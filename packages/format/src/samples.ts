import type { Project } from "./model.js";

/**
 * One place a project names a sample file: which instrument and kit voice asks
 * for it, and where a diagnostic about it points.
 *
 * The `file` and `pointer` fields are the §4 layout applied to a kit voice, and
 * they live here rather than at each call site so that the validator's diagnostics
 * and any other consumer cannot disagree about which pointer describes a voice's
 * sample.
 */
export interface SampleReference {
  /** The project-relative path as written in the document, unvalidated. */
  path: string;
  instrumentId: string;
  voice: string;
  /** Document the reference is written in, for a diagnostic. */
  file: string;
  /** JSON pointer to the `sample` field, for a diagnostic. */
  pointer: string;
}

/**
 * Every sample path a project's instruments name, in instrument order and then
 * kit order.
 *
 * Two callers need this and they need it to agree: `semanticValidate` decides
 * whether each referenced file exists and is a PCM WAV, and the sidecar watches
 * those same files for replacement so that the browser cannot keep playing audio
 * the disk no longer holds (PLAN.md §14). If the two enumerations could drift, a
 * sample the validator checks but the watcher does not know about would be exactly
 * the silent disagreement between the disk and the sound that both exist to prevent.
 *
 * Paths are returned exactly as the document writes them, including ones that are
 * not legal: judging them is the validator's job, and a caller that filtered here
 * would hide a bad path rather than report it.
 */
export function sampleReferences(project: Project): SampleReference[] {
  const references: SampleReference[] = [];
  for (const instrument of project.instruments.values()) {
    if (instrument.type !== "drumkit") continue;
    for (const [voice, kit] of Object.entries(instrument.kit)) {
      references.push({
        path: kit.sample,
        instrumentId: instrument.id,
        voice,
        file: `instruments/${instrument.id}.json`,
        pointer: `/kit/${voice}/sample`,
      });
    }
  }
  return references;
}

/**
 * The distinct sample paths a project references, sorted.
 *
 * Sorted and deduplicated because this is an *inventory*: two kit voices sharing
 * one file are one file to load, hash and watch, and a stable order makes two
 * inventories comparable without either side having to sort first.
 */
export function referencedSamplePaths(project: Project): string[] {
  return [...new Set(sampleReferences(project).map((reference) => reference.path))].sort();
}
