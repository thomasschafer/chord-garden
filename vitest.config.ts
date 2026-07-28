import { defineConfig } from "vitest/config";
import { allPackageExports, sourceAliases } from "./test/workspaceExports.js";

/**
 * Workspace packages resolve to their `src/`, never to their `dist/`.
 *
 * Each of them publishes only `dist/` through its `exports` map, so without these
 * aliases a test in `packages/cli` importing `@chord-garden/engine` runs the last
 * *built* engine rather than the engine on disk. That is not hypothetical:
 * cutting the synth's velocity-to-gain conversion to a hundredth of its value
 * left all 41 `packages/cli` tests green, because they were exercising a `dist/`
 * built before the edit — and those are the strongest audio-behaviour tests in
 * the repo.
 *
 * This is an alias rather than a build step in `pretest` on purpose. A build step
 * only repairs `npm test`; the hazard that actually bites is the inner loop,
 * where `npx vitest run packages/cli` after editing the engine keeps passing
 * against yesterday's artifact and says nothing. An alias makes staleness
 * structurally impossible instead, because `dist/` is never consulted by a test
 * run at all.
 *
 * What the alias costs is coverage of the `exports` maps themselves: with every
 * test on source, a broken map or a missing emit would ship green.
 * `test/publishedEntryPoints.test.ts` puts that property back by resolving the
 * maps in a real Node process, where these aliases do not apply.
 */
export default defineConfig({
  resolve: {
    alias: allPackageExports().flatMap(sourceAliases),
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
      "app/test/**/*.test.ts",
      // Cross-cutting tests that belong to no single package.
      "test/**/*.test.ts",
    ],
    /**
     * Well above vitest's 5 s default, because the renderer tests do seconds of
     * real DSP work rather than waiting on anything.
     *
     * The equivalence and per-voice tests render whole fixtures — one of them
     * three times over, at three lookahead sizes — and take 1.7–3.0 s on a fast
     * laptop. A shared CI runner is two to three times slower, which put them at
     * 5.0–8.7 s and failed a suite that was green locally.
     *
     * This is headroom for slow hardware, not tolerance for flakiness: nothing
     * here sleeps or polls, so a test that takes 30 s has hung rather than
     * dawdled, and the bound is still tight enough to say so.
     */
    testTimeout: 30_000,
  },
});
