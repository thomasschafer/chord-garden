import type { InstrumentDoc, Project } from "@chord-garden/format/pure";

/**
 * Who plays what: the joins between `trackOrder`, tracks and instruments that a
 * mixer and an instrument editor both need.
 *
 * It is here rather than inline in the components for one reason that is not
 * tidiness. An instrument is not owned by a track — the format lets two tracks
 * name the same `instruments/<id>.json`, and nothing in `validate` forbids it — so
 * "the level of track X" and "the level of the instrument track X plays" are the
 * same number for the fixture and different concepts in general. A mixer that does
 * not know the difference silently moves two tracks with one fader. Computing the
 * sharing here means the fact is available to say out loud, and testable without a
 * browser.
 */

/** One mixer channel: a track, and the instrument whose params are its levels. */
export interface Channel {
  trackId: string;
  instrumentId: string;
  /** `undefined` when the track names an instrument that did not load. */
  instrument: InstrumentDoc | undefined;
  /**
   * Other tracks playing this same instrument, in `trackOrder`. Empty in the
   * ordinary case; non-empty means every control on this strip moves those tracks
   * too, because the value lives on the instrument.
   */
  sharedWith: string[];
}

/** A channel per track, in `trackOrder`, skipping ids with no track file. */
export function channels(project: Project): Channel[] {
  const users = trackIdsByInstrument(project);
  const out: Channel[] = [];
  for (const trackId of project.project.trackOrder) {
    const track = project.tracks.get(trackId);
    if (track === undefined) continue;
    out.push({
      trackId,
      instrumentId: track.instrument,
      instrument: project.instruments.get(track.instrument),
      sharedWith: (users.get(track.instrument) ?? []).filter((other) => other !== trackId),
    });
  }
  return out;
}

/** One panel per distinct instrument in use, in the order its first track appears. */
export interface InstrumentPanel {
  instrument: InstrumentDoc;
  /** Every track that plays it, in `trackOrder`. */
  trackIds: string[];
}

export function instrumentPanels(project: Project): InstrumentPanel[] {
  const users = trackIdsByInstrument(project);
  const out: InstrumentPanel[] = [];
  const seen = new Set<string>();
  for (const channel of channels(project)) {
    if (channel.instrument === undefined || seen.has(channel.instrumentId)) continue;
    seen.add(channel.instrumentId);
    out.push({ instrument: channel.instrument, trackIds: users.get(channel.instrumentId) ?? [] });
  }
  return out;
}

function trackIdsByInstrument(project: Project): Map<string, string[]> {
  const users = new Map<string, string[]>();
  for (const trackId of project.project.trackOrder) {
    const track = project.tracks.get(trackId);
    if (track === undefined) continue;
    const list = users.get(track.instrument);
    if (list === undefined) users.set(track.instrument, [trackId]);
    else list.push(trackId);
  }
  return users;
}
