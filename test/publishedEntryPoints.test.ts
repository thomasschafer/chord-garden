import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allPackageExports, REPO_ROOT, type ExportTarget } from "./workspaceExports.js";

/**
 * The counterweight to the source aliases in `vitest.config.ts`.
 *
 * Those aliases make every other test import a workspace package's `src/`, which
 * is what keeps the suite honest about uncommitted edits — but it also means no
 * other test ever resolves an `exports` map. A subpath pointing at a file that is
 * never emitted, a `types` entry left behind by a renamed module, or a package
 * whose build silently produces nothing would all ship green.
 *
 * So this one test deliberately does not use the aliases. It resolves each
 * published specifier in a *separate Node process*, where the vitest resolver has
 * no say and Node's own `exports` handling is what answers, and it reads the
 * built `dist/` rather than the sources.
 *
 * It therefore needs a build. `npm run typecheck` builds everything and CI runs
 * it before `npm test`; locally, `npm run build` once is enough, and a stale
 * build is fine here because this test asks whether entry points *resolve*, not
 * what they compute.
 */

interface Resolution {
  specifier: string;
  ok: boolean;
  error?: string;
  exportNames?: string[];
}

/** Imports each specifier in a fresh Node process and reports what happened. */
const CHILD = `
const specifiers = JSON.parse(process.env.CG_SPECIFIERS);
const results = [];
for (const specifier of specifiers) {
  try {
    const namespace = await import(specifier);
    results.push({ specifier, ok: true, exportNames: Object.keys(namespace) });
  } catch (error) {
    results.push({ specifier, ok: false, error: error instanceof Error ? \`\${error.code ?? error.name}: \${error.message}\` : String(error) });
  }
}
process.stdout.write(JSON.stringify(results));
`;

function resolveInRealNode(specifiers: readonly string[]): Map<string, Resolution> {
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CG_SPECIFIERS: JSON.stringify(specifiers) },
  });
  const results = JSON.parse(stdout) as Resolution[];
  return new Map(results.map((result) => [result.specifier, result]));
}

const packages = allPackageExports();
const entries: { packageName: string; packageDir: string; target: ExportTarget }[] = packages.flatMap((pkg) =>
  pkg.targets.map((target) => ({ packageName: pkg.name, packageDir: pkg.dir, target })),
);
const unbuilt = packages.filter((pkg) => !existsSync(resolve(pkg.dir, "dist"))).map((pkg) => pkg.name);
// Resolving with a package unbuilt would report a wall of identical
// ERR_MODULE_NOT_FOUND rather than the one fact worth reporting, so skip the
// child entirely and let the first assertion say what to do.
const resolutions = unbuilt.length > 0 ? new Map<string, Resolution>() : resolveInRealNode(entries.map((entry) => entry.target.specifier));

describe("published entry points", () => {
  it("has a build to check", () => {
    expect(unbuilt, `run \`npm run build\` first: ${unbuilt.join(", ")} has no dist/`).toEqual([]);
  });

  it("publishes every subpath the source aliases cover", () => {
    // Guards the pairing itself: if this ever came up empty, every assertion
    // below would pass by vacuum.
    expect(entries.length).toBeGreaterThanOrEqual(13);
    expect(packages.map((pkg) => pkg.name).sort()).toEqual([
      "@chord-garden/cli",
      "@chord-garden/dev-server",
      "@chord-garden/engine",
      "@chord-garden/format",
    ]);
  });

  it.each(entries)("resolves $target.specifier through its exports map", ({ packageDir, target }) => {
    const resolution = resolutions.get(target.specifier);
    expect(resolution, `no resolution attempted for ${target.specifier}`).toBeDefined();
    expect(resolution?.error ?? "no error").toBe("no error");
    expect(resolution?.ok).toBe(true);
    // An emitted-but-empty module resolves fine and exports nothing, which is
    // what a build that quietly dropped a file looks like from the outside.
    expect(resolution?.exportNames?.length ?? 0).toBeGreaterThan(0);

    // The runtime import says nothing about the declarations, so a `types` entry
    // pointing at a `.d.ts` that is no longer emitted would break every consumer
    // while this test stayed green.
    const types = resolve(packageDir, target.types);
    expect(existsSync(types), `${target.specifier} declares types at ${target.types}, which is not emitted`).toBe(true);
  });
});
