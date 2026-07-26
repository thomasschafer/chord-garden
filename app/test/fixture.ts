import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@chord-garden/format";
import type { OpenedProject } from "../src/store/documentStore";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");

/**
 * Load a project from disk the way the sidecar does, and package it the way the
 * browser hands it to the store: the assembled model plus the exact bytes each
 * document was served with.
 */
export function openedFrom(root: string): OpenedProject {
  const result = loadProject(root);
  if (result.project === undefined) {
    throw new Error(`fixture at ${root} does not load: ${JSON.stringify(result.diagnostics, null, 2)}`);
  }
  const texts = new Map<string, string>();
  for (const path of result.files.keys()) texts.set(path, readFileSync(join(root, path), "utf8"));
  return { project: result.project, texts, diagnostics: [] };
}
