import { ticksPerBar, type Project } from "@chord-garden/format/pure";
import { useStore } from "zustand";
import { documentStore } from "../session";

/**
 * The project's own fields, with the two editable ones the write path is proved
 * through end to end: the name, and the tempo.
 *
 * Tempo is the interesting one. On disk it is an integer in bpm×100 (PLAN.md
 * §6.2 — no floats anywhere in a canonical file), and the input shows BPM. The
 * conversion happens here, at the edge, and rounds to the stored unit before it
 * reaches the model, so nothing downstream ever holds a tempo the format cannot
 * represent.
 */
export function ProjectHeader({ project }: { project: Project }): React.JSX.Element {
  const setProjectName = useStore(documentStore, (state) => state.setProjectName);
  const setTempoBpmX100 = useStore(documentStore, (state) => state.setTempoBpmX100);

  const doc = project.project;
  const meter = doc.meterMap[0]!.timeSignature;
  const barTicks = ticksPerBar(doc.ppqn, meter);
  const bars = project.arrangement.lengthTicks / barTicks;
  const tempo = doc.tempoMap[0]!.bpm;

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
      </div>
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
