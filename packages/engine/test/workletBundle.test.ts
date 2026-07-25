import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = fileURLToPath(new URL("../src", import.meta.url));
const FORMAT_SRC = fileURLToPath(new URL("../../format/src", import.meta.url));
const WORKLET = resolve(ENGINE_SRC, "live/worklet.ts");

/**
 * Bare specifiers the worklet's runtime graph may reach, and where their source
 * lives so the walk can keep going. Everything here must itself be free of
 * `node:*`, which is the point of the entry: `@chord-garden/format` (the package
 * root) re-exports `loadProject` and its `node:fs` import, so the engine
 * parameter registry has its own subpath export.
 */
const ALLOWED_PACKAGES: Record<string, string> = {
  "@chord-garden/format/registry": resolve(FORMAT_SRC, "registry.ts"),
};

/**
 * Runtime module specifiers in `source`. Type-only imports are dropped because
 * they are erased before a bundler ever sees them; a mixed import keeps its
 * specifier, since it does pull the module in at runtime.
 */
function runtimeSpecifiers(source: string): string[] {
  // The clause may not cross a `;` or a backtick, so an error message that
  // happens to contain `from "..."` cannot be mistaken for an import.
  const withoutTypeOnly = source.replace(/^\s*(?:import|export)\s+type\s[^;]*;/gm, "");
  const specifiers: string[] = [];
  for (const match of withoutTypeOnly.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;`]*?from\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]!);
  }
  for (const match of withoutTypeOnly.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(`dynamic:${match[1]!}`);
  }
  return specifiers;
}

interface Module {
  file: string;
  source: string;
}

/** Every module the worklet reaches at runtime, following relative imports. */
function workletGraph(): { modules: Module[]; bare: string[] } {
  const visited = new Set<string>();
  const modules: Module[] = [];
  const bare = new Set<string>();
  const queue = [WORKLET];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    modules.push({ file, source });
    for (const specifier of runtimeSpecifiers(source)) {
      if (specifier.startsWith("dynamic:")) {
        bare.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        continue;
      }
      bare.add(specifier);
      const source = ALLOWED_PACKAGES[specifier];
      if (source !== undefined) queue.push(source);
    }
  }
  return { modules, bare: [...bare].sort() };
}

/**
 * The AudioWorklet environment has no `node:*`, no DOM, no `fetch`, and no
 * dynamic `import`, and the module is loaded through `addModule` as one
 * self-contained file. None of that is observable from the Node test double, so it
 * is checked here, statically, over the real import graph.
 */
describe("worklet module constraints", () => {
  const { modules, bare } = workletGraph();

  it("reaches only modules that can exist inside an AudioWorklet", () => {
    expect(bare).toEqual(["@chord-garden/format/registry"]);
    expect(modules.length).toBeGreaterThan(8);
  });

  it("imports nothing from node, the DOM, or the network anywhere in the graph", () => {
    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of runtimeSpecifiers(module.source)) {
        if (specifier.startsWith("node:") || specifier.startsWith("dynamic:")) {
          offenders.push(`${module.file}: ${specifier}`);
        }
      }
      for (const forbidden of ["fetch(", "XMLHttpRequest", "document.", "window.", "localStorage"]) {
        if (module.source.includes(forbidden)) offenders.push(`${module.file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registers the processor from module scope", () => {
    const worklet = modules.find((module) => module.file === WORKLET);
    expect(worklet?.source).toMatch(/^registerProcessor\(/m);
  });

  /**
   * PLAN.md's rule for `dsp/`: no `node:*`, no Web Audio, no `Math.random`, no
   * clock. Asserted over the directory rather than argued, because the whole
   * one-DSP-core guarantee rests on it.
   */
  it("keeps the DSP core free of the platform", () => {
    const offenders: string[] = [];
    // `sampleRate` is fine as a parameter and is how the DSP is told the rate;
    // what must not appear is any reference to an ambient one.
    const forbidden = ["node:", "Math.random", "Date.now", "performance.now", "AudioContext", "AudioWorklet", "globalThis"];
    for (const module of modules) {
      if (!module.file.includes("/dsp/")) continue;
      for (const term of forbidden) {
        if (module.source.includes(term)) offenders.push(`${module.file}: ${term}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(modules.filter((module) => module.file.includes("/dsp/")).length).toBeGreaterThan(4);
  });
});
