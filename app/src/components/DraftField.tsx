import { useEffect, useState } from "react";

/**
 * A text or number box that edits the document when you have finished typing, not
 * while you are typing.
 *
 * This exists because the obvious version is unusable. A controlled input bound
 * straight to the model commits every keystroke, and every keystroke has to be a
 * valid document: turning `A1` into `A#1` passes through `A`, which the pitch grammar
 * rejects, so the edit throws and React puts `A1` back — the field cannot be typed
 * in at all. Numbers are worse, because the intermediate states are *valid*: deleting
 * a digit of `startTick: 960` commits `96` on the way past, which is a real edit, a
 * real recompile and a real file write for a value nobody asked for.
 *
 * So the box owns a draft. `Enter` and losing focus commit it; `Escape` abandons it;
 * and while it is being typed the model is untouched. A rejected commit leaves the
 * draft alone so the text can be corrected rather than snapping back.
 */
export function DraftField({
  value,
  onCommit,
  kind = "text",
  placeholder,
  size = 7,
  label,
}: {
  /** The document's current value, and what the draft resets to. */
  value: string;
  /**
   * Commit the box's text. Throwing rejects the commit; the caller reports why and
   * the draft stays as typed.
   */
  onCommit: (text: string) => void;
  kind?: "text" | "number";
  placeholder?: string;
  size?: number;
  label: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  // Adopt the document's value whenever it changes underneath — another editor, an
  // undo, a drag of the same note — except while this box is being typed in, which
  // is the one time the draft is the more recent intent.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit(): void {
    if (draft === value) return;
    onCommit(draft);
  }

  return (
    <input
      type={kind}
      value={draft}
      aria-label={label}
      {...(placeholder === undefined ? {} : { placeholder })}
      size={size}
      step={kind === "number" ? 1 : undefined}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onBlur={() => {
        setEditing(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
          setDraft(value);
          return;
        }
        // Arrow keys in a piano-roll inspector must not also move the selected note:
        // the roll listens for them on the note itself.
        event.stopPropagation();
      }}
    />
  );
}
