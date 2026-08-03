import type { EditEvent } from '../types';

type Props = {
  edits: EditEvent[];
};

/**
 * The corrections the analyst has made but not yet submitted.
 *
 * Rendered from state rather than appended to the chat log, because these are
 * current state and the log is history. Appending each correction as it happened
 * meant a field changed, reverted, then changed again produced three lines
 * describing one correction — and the analyst only cares about where it ended up.
 *
 * Shown as one block rather than one entry per field on purpose: corrections
 * made together are usually related. Six values all wrong by a factor of a
 * thousand is one mistake about units, not six mistakes about six fields, and
 * diagnosing them separately would find six coincidences instead of a cause.
 */
export default function PendingEdits({ edits }: Props) {
  if (edits.length === 0) return null;

  return (
    <section className="pending" aria-label="Pending corrections">
      <h2 className="pending-title">
        {edits.length} correction{edits.length === 1 ? '' : 's'} — not yet submitted
      </h2>

      <ul className="pending-list">
        {edits.map((edit) => (
          <li key={edit.fieldKey}>
            <span className="pending-field">{edit.fieldKey}</span>
            <span className="pending-change">
              {edit.from === '' ? 'blank' : edit.from} → {edit.to === '' ? 'blank' : edit.to}
            </span>
          </li>
        ))}
      </ul>

      <p className="subtle pending-note">
        Sent together when you confirm, so related corrections are read as one change.
      </p>
    </section>
  );
}
