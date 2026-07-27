import { instrumentParams, type InstrumentDoc, type InstrumentParam, type Project } from "@chord-garden/format/pure";
import { useState } from "react";
import { instrumentPanels } from "../view/instruments";
import { ParamControl } from "./ParamControl";

/**
 * Every param of every instrument in the project, editable.
 *
 * The list is `instrumentParams(instrument)` and nothing else: this file contains
 * no param name, no unit, no range and no default, so the editor a `basic-mono`
 * gets and the editor a `basic-poly` gets differ by exactly what the registry says
 * differs, and a param added to the registry appears here with the right control.
 * `app/test/instrumentParams.test.ts` asserts that as a property rather than
 * leaving it as a claim.
 *
 * Drumkit params are grouped by voice because that is what they are — the registry
 * declares them as `<voice>.<param>` and there are no kit-wide ones
 * (docs/format-spec.md §6) — and a flat list of `hat.chokeGroup`, `hat.gain`,
 * `kick.chokeGroup`, `kick.gain` is the same information sorted the least useful
 * way.
 *
 * The mixer draws the level and pan params of these same instruments as faders.
 * That is deliberate duplication rather than an oversight: this section is the
 * whole document, one control per param, and the mixer is the two params you reach
 * for constantly, as the gesture they deserve. Both are views of one `params` map,
 * and either one moving shows up in the other immediately, which is the same claim
 * PLAN.md §3 makes about the UI and an agent.
 */
export function InstrumentEditors({ project }: { project: Project }): React.JSX.Element {
  const panels = instrumentPanels(project);

  return (
    <section>
      <h2>instruments</h2>
      <p className="muted">
        every param the engine registry declares. an empty box means the param&rsquo;s default, shown as the
        placeholder; emptying a box — or typing the default back — removes it from the file rather than writing a
        value equal to the default.
      </p>
      {panels.length === 0 ? (
        <p className="muted">no instrument loaded.</p>
      ) : (
        panels.map((panel) => (
          <InstrumentPanelView key={panel.instrument.id} instrument={panel.instrument} trackIds={panel.trackIds} />
        ))
      )}
    </section>
  );
}

function InstrumentPanelView({
  instrument,
  trackIds,
}: {
  instrument: InstrumentDoc;
  trackIds: readonly string[];
}): React.JSX.Element {
  const [error, setError] = useState<string | undefined>(undefined);
  const params = instrumentParams(instrument);
  const voices = groupByVoice(params);

  return (
    <div className="editor">
      <h3>
        {instrument.id}{" "}
        <span className="muted">
          {instrument.type === "synth" ? `synth, ${instrument.engine}` : "drumkit"} — played by{" "}
          {trackIds.length === 1 ? `track ${trackIds[0]!}` : `tracks ${trackIds.join(", ")}`}
        </span>
      </h3>
      {voices.shared.length > 0 && (
        <div className="fields">
          {voices.shared.map((param) => (
            <ParamControl key={param.key} instrument={instrument} param={param} label={param.key} onError={setError} />
          ))}
        </div>
      )}
      {voices.perVoice.map(([voice, group]) => (
        <div key={voice} className="param-group">
          <span className="param-group-name">{voice}</span>
          <div className="fields">
            {group.map((param) => (
              <ParamControl
                key={param.key}
                instrument={instrument}
                param={param}
                // The voice already names itself to the left, so the row says
                // `gain`, not `kick.gain`.
                label={param.key.slice(voice.length + 1)}
                onError={setError}
              />
            ))}
          </div>
        </div>
      ))}
      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Params split into the instrument's own and those namespaced under a kit voice,
 * with the voices in kit order.
 *
 * Driven by `InstrumentParam.voice`, which the registry fills in for the params it
 * namespaces, so this needs to know nothing about drumkits: an engine that later
 * namespaces params some other way groups correctly the moment `resolveParam`
 * reports the namespace.
 */
export function groupByVoice(params: readonly InstrumentParam[]): {
  shared: InstrumentParam[];
  perVoice: [string, InstrumentParam[]][];
} {
  const shared: InstrumentParam[] = [];
  const perVoice = new Map<string, InstrumentParam[]>();
  for (const param of params) {
    if (param.voice === undefined) {
      shared.push(param);
      continue;
    }
    const group = perVoice.get(param.voice);
    if (group === undefined) perVoice.set(param.voice, [param]);
    else group.push(param);
  }
  return { shared, perVoice: [...perVoice] };
}
