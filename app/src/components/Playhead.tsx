/**
 * The playhead line. Its own component so a position report — about 47 a second —
 * re-renders one absolutely positioned div and not the grid behind it.
 */
export function Playhead({ leftPx }: { leftPx: number }): React.JSX.Element {
  return <div className="playhead" style={{ left: leftPx }} aria-hidden="true" />;
}
