import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Which modules may see the transport's playback position.
 *
 * A worklet report arrives about 47 times a second. React re-renders a component
 * whose state or props changed *and everything under it*, so a position held
 * anywhere above the editors re-renders every note of every pattern 47 times a
 * second — and a piano roll's notes cannot be memoized away, because they depend on
 * the drag and selection state that makes them notes you can drag. The fix is
 * structural rather than a memo: the position goes to the one leaf that draws it and
 * to the readout that reports it, and to nothing that has an editor beneath it.
 *
 * That is an architectural property, so it is tested architecturally, the way
 * `packages/engine/test/workletBundle.test.ts` tests "the worklet reaches no
 * `node:*`" — by reading the sources rather than by rendering. It cannot see a
 * re-render, and it does not try to; what it pins is the data path that caused
 * them, so that restoring the path is a failing test rather than a code review.
 *
 * If this test fails on a new file, the question to answer is not "how do I get past
 * this test" but "does a position report now re-render an editor". Add the file here
 * only once the answer is no.
 */

/**
 * Names that mean "this module can reach the moving transport position".
 * `LivePlayer` (the class) is deliberately not among them: `session.ts` constructs
 * one, which is not the same as reading a position out of it.
 */
const POSITION_NAMES = ["livePlayer", "PlayerStatus", "positionSample"] as const;

/** Every module in the app's source tree, as a repo-relative path. */
function appModules(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path);
    }
  };
  walk(APP_SRC);
  return found;
}

/**
 * The names a module actually *uses*.
 *
 * Comments and string literals are dropped first, in that order: `audio/livePlayer`
 * is a module path in half the app's import statements without being a use of the
 * player, and these sources explain themselves at length, so a prose mention of
 * `positionSample` must not read as one either. Block comments go before line
 * comments so an apostrophe in a comment cannot start a "string", and line comments
 * before strings so a `//` inside a string cannot end a line — neither of which is
 * general JavaScript lexing, but both of which hold for this tree, and the failure
 * mode is a visible mismatch rather than a quiet pass.
 */
function positionNamesIn(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, '""');
  return POSITION_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
}

describe("the path a playback position takes through the UI", () => {
  it("is confined to the player, the readout, the playhead and the arithmetic between them", () => {
    const seen: Record<string, string[]> = {};
    for (const path of appModules()) {
      const names = positionNamesIn(readFileSync(path, "utf8"));
      if (names.length > 0) seen[relative(APP_SRC, path)] = names;
    }

    expect(seen).toEqual({
      // The player itself: it is where a position report arrives.
      "audio/livePlayer.ts": ["PlayerStatus", "positionSample"],
      // The playhead line, which subscribes to the player directly. A leaf, so a
      // report re-renders one absolutely positioned div and nothing else.
      "components/Playhead.tsx": ["livePlayer"],
      // The transport readout, which exists to show the position moving. Also a
      // leaf: it renders no editor, and passes its status to nobody.
      "components/Transport.tsx": ["livePlayer", "PlayerStatus", "positionSample"],
      // Constructs the one player for the window; never reads a position from it.
      "session.ts": ["livePlayer"],
      // Turns a status into a tick inside a pattern. Pure, and type-only in its
      // reference to the player, so it stays testable without a browser.
      "view/playback.ts": ["PlayerStatus", "positionSample"],
    });
  });

  it("keeps it out of every component that renders an editor", () => {
    // Spelled out separately from the exact set above, because this is the half
    // that matters and the failure should say so. These four are the whole path
    // from the root to a note: if a position reaches any of them, every note in
    // every pattern re-renders about 47 times a second.
    for (const path of ["App.tsx", "components/PatternEditors.tsx", "components/PianoRoll.tsx", "components/StepSequencer.tsx"]) {
      const names = positionNamesIn(readFileSync(join(APP_SRC, path), "utf8"));
      expect(names, `${path} can see the transport position`).toEqual([]);
    }
  });
});
