import { useRef, useState } from "react";

/**
 * A pointer drag in progress: held in a ref for decisions, mirrored in state for
 * drawing.
 *
 * The obvious implementation is `useState` alone, and it is wrong in a way that
 * only shows up at speed. `pointerdown` sets the drag; a `pointermove` that
 * arrives before React has re-rendered still sees the previous render's
 * `undefined` and bails out, and so does the `pointerup` that follows it. A slow
 * drag therefore works and a fast one selects the thing and moves nothing — a
 * bug invisible to anyone testing by hand, which is exactly how it survived
 * until a browser automation tool, whose drags are instantaneous, produced it
 * every time.
 *
 * So the ref is the authority. Handlers read `ref.current` and write through
 * `set`; the returned value is for rendering the preview only.
 */
export function useDragState<T>(): {
  /** The drag as last rendered. For drawing a preview, never for a decision. */
  shown: T | undefined;
  /** The drag as it is right now, whatever React has or has not re-rendered. */
  ref: { readonly current: T | undefined };
  set: (next: T | undefined) => void;
} {
  const ref = useRef<T | undefined>(undefined);
  const [shown, setShown] = useState<T | undefined>(undefined);
  return {
    shown,
    ref,
    set: (next) => {
      ref.current = next;
      setShown(next);
    },
  };
}
