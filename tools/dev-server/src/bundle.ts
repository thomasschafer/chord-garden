import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build, type BuildOptions } from "esbuild";
import { LIVE_PROCESSOR_NAME } from "@chord-garden/engine/live";

/** Repository root, from this module's location in `tools/dev-server/dist`. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface BundleOutput {
  name: string;
  path: string;
  bytes: number;
}

/**
 * Build the two files a browser loads: the harness page's script, and the
 * AudioWorklet module.
 *
 * The worklet is bundled from the engine's *build output* rather than its
 * source, because `addModule` loads one self-contained file and the thing worth
 * proving is that the real compiled module has no bare specifiers left in it —
 * see `assertSelfContained` and `assertRegistersProcessor`. `workletBundle.test.ts`
 * proves the import graph could bundle; this proves a bundler did.
 */
export async function buildWebBundles(outDir: string): Promise<BundleOutput[]> {
  mkdirSync(outDir, { recursive: true });
  const shared: BuildOptions = {
    bundle: true,
    target: "es2022",
    platform: "browser",
    sourcemap: true,
    metafile: true,
    logLevel: "silent",
    absWorkingDir: REPO_ROOT,
  };

  const worklet = join(outDir, "worklet.js");
  const workletResult = await build({
    ...shared,
    entryPoints: [join(REPO_ROOT, "packages/engine/dist/live/worklet.js")],
    outfile: worklet,
    // An AudioWorklet module is evaluated in a scope with no module loader worth
    // relying on, so nothing may survive as an import or an export. IIFE is the
    // format that holds whether the browser treats it as a module or a script.
    format: "iife",
  });
  if (workletResult.metafile === undefined) throw new Error("esbuild produced no metafile for the worklet bundle");
  assertSelfContained(workletResult.metafile, worklet);
  assertRegistersProcessor(readFileSync(worklet, "utf8"), worklet);

  const harness = join(outDir, "harness.js");
  await build({
    ...shared,
    entryPoints: [join(REPO_ROOT, "tools/dev-server/web/main.ts")],
    outfile: harness,
    format: "esm",
  });

  return [worklet, harness].map((path) => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    bytes: readFileSync(path).byteLength,
  }));
}

interface Metafile {
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}

/** Fail the build if anything is left for the browser to resolve at load time. */
function assertSelfContained(metafile: Metafile, outfile: string): void {
  const unresolved = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.filter((entry) => entry.external === true).map((entry) => entry.path),
  );
  if (unresolved.length > 0) {
    throw new Error(`${outfile} still imports ${unresolved.join(", ")}; AudioWorklet.addModule cannot resolve those`);
  }
}

/**
 * Evaluate the bundle the way a worklet would and require it to register.
 *
 * Cheap, and it closes the one gap the Node test double cannot: the double
 * imports `worklet.ts` through Node's resolver, so it would keep working even if
 * the bundle were broken. This runs the *bundled bytes* in a context that has
 * nothing but the AudioWorklet globals — no `require`, no `process`, no DOM — so
 * anything that reached for the platform fails here instead of in Chrome.
 */
function assertRegistersProcessor(code: string, outfile: string): void {
  const registered: string[] = [];
  const context = createContext({
    sampleRate: 48_000,
    currentFrame: 0,
    currentTime: 0,
    AudioWorkletProcessor: class {
      readonly port = { postMessage(): void {}, onmessage: null };
    },
    registerProcessor: (name: string) => {
      registered.push(name);
    },
  });
  try {
    runInContext(code, context, { filename: outfile });
  } catch (error) {
    throw new Error(`${outfile} threw while evaluating as an AudioWorklet module: ${String(error)}`);
  }
  if (!registered.includes(LIVE_PROCESSOR_NAME)) {
    throw new Error(`${outfile} registered [${registered.join(", ")}] instead of "${LIVE_PROCESSOR_NAME}"`);
  }
}
