import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts", "app/test/**/*.test.ts"],
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
