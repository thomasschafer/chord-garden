import { useEffect, useState } from "react";
import type { PlayerStatus } from "../audio/livePlayer";
import { livePlayer } from "../session";
import { dbfsLabel } from "../view/mixer";

/**
 * The master peak, as the number PLAN.md §6.3 says an author is owed.
 *
 * A leaf that subscribes to the player itself, for the reason `Playhead.tsx`
 * explains at length: a worklet report arrives about 47 times a second, and
 * anything above the mixer strips that held it would re-render every fader in the
 * project at that rate — including the one under the pointer.
 *
 * It lives in its own file for the same reason `PatternPlayhead` does, and that
 * is not cosmetic: `positionPath.test.ts` pins which *files* may see the player,
 * so a meter sharing a file with the faders would license the whole mixer to
 * read a position it must not. The file boundary is what makes the isolation
 * checkable rather than a matter of trusting the reader to notice.
 */
export function MasterMeter(): React.JSX.Element {
  const [status, setStatus] = useState<PlayerStatus>(() => livePlayer.getStatus());
  useEffect(() => livePlayer.subscribe(setStatus), []);

  const clipped = status.peakSession > 1;
  return (
    <p className={clipped ? "warn" : "muted"}>
      master peak {dbfsLabel(status.peak)} now, {dbfsLabel(status.peakSession)} this run
      {clipped
        ? " — over 0 dBFS. nothing is limiting it: the float master is genuinely past full scale, and render --analyze reports the same overshoot. Pull a fader down."
        : status.phase === "playing"
          ? ""
          : " (not playing)"}
    </p>
  );
}
