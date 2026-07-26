import type { Project } from "@chord-garden/format/pure";
import { useCallback, useSyncExternalStore } from "react";
import { livePlayer } from "../session";
import { livePatternTick } from "../view/playback";

/**
 * The playhead line inside one pattern's canvas, or nothing when no clip of that
 * pattern is sounding.
 *
 * It reads the player itself instead of being handed a position from above, and
 * that is the entire point of the component. A worklet report arrives about 47
 * times a second (`LivePlayer.handleEvent`), so a position held in the state of
 * any component above an editor re-renders that whole editor 47 times a second —
 * every note of a piano roll included, since a note's element depends on the drag
 * and selection state that makes it unmemoizable. Nothing else in the tree needs
 * the position, so nothing else is told about it: the deepest component that
 * needs a fact should be the one that subscribes to it.
 *
 * `LivePlayer` is already an external store — `subscribe` plus `getStatus` — so
 * this is `useSyncExternalStore` against it directly rather than a second copy of
 * the same fact in a React store. The snapshot is the pattern-local tick, a
 * number, which also means a report that does not move this playhead (because the
 * transport is elsewhere in the arrangement, or stopped) re-renders nothing at
 * all.
 */
export function PatternPlayhead({
  project,
  trackId,
  patternId,
  pxPerTick,
}: {
  project: Project;
  trackId: string;
  patternId: string;
  pxPerTick: number;
}): React.JSX.Element | null {
  const subscribe = useCallback((onChange: () => void) => livePlayer.subscribe(onChange), []);
  const getSnapshot = useCallback(
    () => livePatternTick(project, trackId, patternId, livePlayer.getStatus()),
    [project, trackId, patternId],
  );
  const localTick = useSyncExternalStore(subscribe, getSnapshot);

  if (localTick === undefined) return null;
  return <div className="playhead" style={{ left: localTick * pxPerTick }} aria-hidden="true" />;
}
