import { useId } from "react";

/** Editable list of daily times ("HH:mm"). */
export function TimesField({ times, onChange, error }: { times: string[]; onChange: (t: string[]) => void; error?: string }) {
  const id = useId();
  return (
    <fieldset className="mb-5" aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}>
      <legend className="mb-1 font-bold">Times each day</legend>
      <p id={`${id}-hint`} className="mb-2 text-sm text-muted">
        In the elderly person’s local time.
      </p>
      <ul className="space-y-2">
        {times.map((t, i) => (
          <li key={i} className="flex items-center gap-2">
            <label htmlFor={`${id}-${i}`} className="sr-only">
              Time {i + 1}
            </label>
            <input
              id={`${id}-${i}`}
              type="time"
              required
              value={t}
              onChange={(e) => onChange(times.map((x, j) => (j === i ? e.target.value : x)))}
              className="rounded-lg border-2 border-line bg-surface px-3 py-2"
            />
            {times.length > 1 && (
              <button
                type="button"
                onClick={() => onChange(times.filter((_, j) => j !== i))}
                className="min-h-11 rounded-lg border border-line px-3 text-sm hover:bg-canvas"
              >
                Remove<span className="sr-only"> time {i + 1}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {times.length < 8 && (
        <button type="button" onClick={() => onChange([...times, "12:00"])} className="mt-2 min-h-11 font-bold text-brand underline">
          + Add another time
        </button>
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1 text-sm font-bold text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Collapses per-index time errors ("times.0") into one message for the field. */
export const timesError = (fields: Record<string, string>) =>
  fields.times ?? Object.entries(fields).find(([k]) => k.startsWith("times."))?.[1];
