import { describeExpressionRange, EXPRESSION_FIELDS, ticksPerBar, type Project } from "@chord-garden/format/pure";
import { useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";

/**
 * The project's own fields: the name, the tempo, and the swing every grid lane
 * inherits.
 *
 * Tempo is the interesting one. On disk it is an integer in bpm×100 (PLAN.md
 * §6.2 — no floats anywhere in a canonical file), and the input shows BPM. The
 * conversion happens here, at the edge, and rounds to the stored unit before it
 * reaches the model, so nothing downstream ever holds a tempo the format cannot
 * represent.
 *
 * Swing is a slider as well as a number because it is the one setting nobody
 * types a value for — you move it until the groove sits right. Its bounds come
 * from the expression registry rather than from `0` and `1000` written here, and
 * the caption names the two landmarks (straight, and roughly triplet) that make
 * the range mean something. What it does *not* do is claim the whole project
 * will change: only odd-indexed steps move, and which hits that reaches is a
 * per-lane fact the lane panel states.
 */
export function ProjectHeader({ project }: { project: Project }): React.JSX.Element {
  const setProjectName = useStore(documentStore, (state) => state.setProjectName);
  const setTempoBpmX100 = useStore(documentStore, (state) => state.setTempoBpmX100);
  const setProjectSwing = useStore(documentStore, (state) => state.setProjectSwing);
  const [error, setError] = useState<string | undefined>(undefined);

  const doc = project.project;
  const meter = doc.meterMap[0]!.timeSignature;
  const barTicks = ticksPerBar(doc.ppqn, meter);
  const bars = project.arrangement.lengthTicks / barTicks;
  const tempo = doc.tempoMap[0]!.bpm;

  /**
   * A half-typed number box parses to NaN, and a slider never can, so both go
   * through one commit that refuses anything the model would not accept. The
   * store checks the range against the registry; this only has to keep NaN out.
   */
  function commitSwing(text: string): void {
    const permille = Number(text);
    if (!Number.isFinite(permille)) return;
    try {
      setProjectSwing(Math.round(permille));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section>
      <h2>project</h2>
      <div className="fields">
        <label>
          name
          <input
            type="text"
            value={doc.name}
            size={28}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </label>
        <label>
          tempo (BPM)
          <input
            type="number"
            step="0.01"
            min="1"
            value={tempo / 100}
            size={8}
            onChange={(event) => {
              const bpm = Number(event.target.value);
              // An empty or half-typed field parses to NaN; leaving the model
              // alone is right, and writing NaN×100 into a document that may
              // only hold integers is very much not.
              if (Number.isFinite(bpm) && bpm > 0) setTempoBpmX100(Math.round(bpm * 100));
            }}
          />
        </label>
        <label>
          swing
          <input
            type="range"
            min={EXPRESSION_FIELDS.swing.min}
            max={EXPRESSION_FIELDS.swing.max}
            step={5}
            value={doc.swing}
            aria-label="project swing"
            onChange={(event) => commitSwing(event.target.value)}
          />
          <input
            type="number"
            min={EXPRESSION_FIELDS.swing.min}
            max={EXPRESSION_FIELDS.swing.max}
            step={1}
            value={doc.swing}
            size={6}
            aria-label="project swing permille"
            onChange={(event) => commitSwing(event.target.value)}
          />
          <span className="muted">
            {describeExpressionRange("swing")} — 0 straight, ~667 triplet; delays odd-indexed steps only
          </span>
        </label>
      </div>
      {error !== undefined && <p className="error">{error}</p>}
      <div className="status">
        <span>key</span>
        <span>{doc.key === undefined ? "-" : `${doc.key.root} ${doc.key.scale}`}</span>
        <span>meter</span>
        <span>
          {meter[0]}/{meter[1]}
        </span>
        <span>bars</span>
        <span>
          {bars} ({project.arrangement.lengthTicks} ticks at {doc.ppqn} PPQN)
        </span>
        <span>swing</span>
        <span>{doc.swing} permille</span>
        <span>format</span>
        <span>{doc.format}</span>
        {doc.description !== undefined && (
          <>
            <span>description</span>
            <span>{doc.description}</span>
          </>
        )}
      </div>
    </section>
  );
}
