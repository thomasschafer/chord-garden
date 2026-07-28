import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The smallest thing `loadProject` will read: the two required documents, and
 * the per-object directories, empty.
 *
 * Tests that need a project with something *wrong* on disk build it here rather
 * than under `fixtures/`, because the fixtures are a contract (PLAN.md §18) and
 * because a FIFO or a mode-000 file cannot be committed to git in the first
 * place.
 */
export function createTempProject(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `chord-garden-${label}-`));
  for (const dir of ["tracks", "patterns", "instruments", "automation", "samples"]) {
    mkdirSync(join(root, dir));
  }
  writeFileSync(
    join(root, "project.json"),
    JSON.stringify({
      format: 1,
      name: label,
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: [],
    }),
  );
  writeFileSync(join(root, "arrangement.json"), JSON.stringify({ lengthTicks: 3840, clips: [] }));
  return root;
}

/** Adds a drumkit whose only voice points at `sample`, so the sample is checked. */
export function addDrumkitReferencing(root: string, sample: string): void {
  writeFileSync(
    join(root, "instruments", "k.json"),
    JSON.stringify({ id: "k", type: "drumkit", kit: { kick: { sample } } }),
  );
}
