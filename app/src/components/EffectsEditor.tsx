import {
  EFFECT_TYPES,
  effectParams,
  effectiveEffectParamValue,
  type EffectDoc,
  type EffectType,
  type Project,
} from "@chord-garden/format/pure";
import { useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import { ParamField } from "./ParamControl";

/**
 * A track's effect chain: what is in it, in what order, and every param of each.
 *
 * Like `InstrumentEditor`, this file names no param: the controls come from
 * `effectParams(effect)`, so a param added to `EFFECT_PARAMS` becomes editable with
 * nothing here touched, and the type list comes from `EFFECT_TYPES`.
 *
 * Two things about the chain are worth stating because they are the point of the
 * design rather than incidental:
 *
 * **Order is the signal path, and only that.** Moving an effect changes what the
 * audio passes through first and nothing else. No automation lane re-targets,
 * because a lane names an effect by its `id`, so the same `fx.room.mix` reaches the
 * same reverb whether it is first or last in the chain. Worth knowing while using
 * it: with every param holding still these three effects commute, so reordering a
 * static chain is inaudible — it is when a param is automated that the order
 * matters, and then it matters a great deal (`chainEditEffect`).
 *
 * **Adding or removing is structural; a param is not.** So a fader here is heard in
 * the next scheduling window, while adding a delay waits for the next bar line. The
 * store makes that claim and the worklet refuses it if it is wrong; this component
 * only reports the refusal.
 */
export function EffectsEditors({ project }: { project: Project }): React.JSX.Element | null {
  const tracks = project.project.trackOrder
    .map((trackId) => project.tracks.get(trackId))
    .filter((track): track is NonNullable<typeof track> => track !== undefined);
  if (tracks.length === 0) return null;

  return (
    <section>
      <h2>effects</h2>
      <p className="muted">
        one chain per track, applied in the order shown. an effect is addressed by its id, so moving it changes what
        the audio passes through first and re-targets no automation lane. adding or removing one lands at the next bar
        line; a param is heard in the next scheduling window.
      </p>
      {tracks.map((track) => (
        <TrackChain key={track.id} trackId={track.id} effects={track.effects ?? []} />
      ))}
    </section>
  );
}

function TrackChain({ trackId, effects }: { trackId: string; effects: readonly EffectDoc[] }): React.JSX.Element {
  const addEffect = useStore(documentStore, (state) => state.addEffect);
  const [type, setType] = useState<EffectType>(EFFECT_TYPES[0]!);
  const [error, setError] = useState<string | undefined>(undefined);

  // Ids are the format's own kebab-case, and must be unique within this chain.
  const suggestedId = (candidate: EffectType): string => {
    const taken = new Set(effects.map((effect) => effect.id));
    if (!taken.has(candidate)) return candidate;
    for (let index = 2; ; index++) {
      const id = `${candidate}-${index}`;
      if (!taken.has(id)) return id;
    }
  };

  function attempt(action: () => void): void {
    try {
      action();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <strong>{trackId}</strong>
        <label>
          add
          <select
            value={type}
            aria-label={`${trackId} effect type`}
            onChange={(event) => setType(event.target.value as EffectType)}
          >
            {EFFECT_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label={`${trackId} add effect`}
          onClick={() => {
            attempt(() => {
              addEffect(trackId, suggestedId(type), type);
            });
          }}
        >
          add
        </button>
        <span className="muted">{effects.length === 0 ? "no effects" : `${effects.length} in chain`}</span>
      </div>
      {error === undefined ? null : <p className="error">{error}</p>}
      {effects.map((effect, index) => (
        <EffectPanel
          key={effect.id}
          trackId={trackId}
          effect={effect}
          index={index}
          count={effects.length}
          onError={setError}
        />
      ))}
    </div>
  );
}

function EffectPanel({
  trackId,
  effect,
  index,
  count,
  onError,
}: {
  trackId: string;
  effect: EffectDoc;
  index: number;
  count: number;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  // Every action is pulled off the store detached, which is why none of them may
  // read `this` (see `setInstrumentParam` in the store for the bug that taught us).
  const setEffectParam = useStore(documentStore, (state) => state.setEffectParam);
  const removeEffect = useStore(documentStore, (state) => state.removeEffect);
  const moveEffect = useStore(documentStore, (state) => state.moveEffect);

  function attempt(action: () => void): void {
    try {
      action();
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="param-group">
      <span className="param-group-name">
        {index + 1}. {effect.id} <span className="muted">{effect.type}</span>
      </span>
        <button
          type="button"
          aria-label={`${trackId} ${effect.id} move earlier`}
          disabled={index === 0}
          onClick={() => {
            attempt(() => {
              moveEffect(trackId, effect.id, index - 1);
            });
          }}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`${trackId} ${effect.id} move later`}
          disabled={index === count - 1}
          onClick={() => {
            attempt(() => {
              moveEffect(trackId, effect.id, index + 1);
            });
          }}
        >
          ↓
        </button>
        <button
          type="button"
          aria-label={`${trackId} ${effect.id} remove`}
          onClick={() => {
            attempt(() => {
              removeEffect(trackId, effect.id);
            });
          }}
        >
          remove
        </button>
      <div className="fields">
        {effectParams(effect).map((param) => (
          <ParamField
            key={param.key}
            param={param}
            label={param.key}
            field={`${trackId} ${effect.id} ${param.key}`}
            override={effect.params?.[param.key]}
            effective={effectiveEffectParamValue(effect, param.key)}
            apply={(value) => {
              attempt(() => {
                setEffectParam(trackId, effect.id, param.key, value);
              });
            }}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}
