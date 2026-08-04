import type { ReviewField } from '../api';

type Props = {
  fields: ReviewField[];
  edits: Record<string, string>;
  /** Per-field rejections from the customer's system, keyed by field. */
  problems: Record<string, string>;
  /** Approved analyses are read-only: the customer's database now owns them. */
  readOnly: boolean;
  onEdit: (key: string, value: string) => void;
  /** Fired when the analyst leaves a field, so a correction is captured once. */
  onCommit: (key: string) => void;
  onRevert: (key: string) => void;
};

/**
 * The readable form of whatever the analyst typed. Money gets grouped digits;
 * anything that is not a number is shown back unchanged, because the customer's
 * schema decides what a field holds and this table does not get to assume.
 *
 * Grouped rather than abbreviated: "$462.1B" would hide the digit an analyst is
 * checking against the page.
 */
function readable(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber)) return trimmed;

  // minimumFractionDigits has to be set: currency defaults it to 2, which
  // renders whole dollars as "$462,090,073,000.00". Cents are noise on a figure
  // this size, but a genuinely fractional value must still show them.
  return asNumber.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export default function ReviewTable({
  fields,
  edits,
  problems,
  readOnly,
  onEdit,
  onCommit,
  onRevert,
}: Props) {
  return (
    <table className="review-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const original = field.value === null ? '' : String(field.value);
          const current = field.key in edits ? edits[field.key] : original;
          const edited = field.key in edits;
          const shown = readable(current);
          const problem = problems[field.key];

          return (
            <tr
              key={field.key}
              className={[
                shown === null ? 'row-blank' : '',
                edited ? 'row-edited' : '',
                problem ? 'row-rejected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <td>
                <span className="field-key">{field.key}</span>
                {edited ? (
                  <span className="confidence edited-tag">edited</span>
                ) : (
                  <span className={`confidence confidence-${field.confidence}`}>
                    {field.confidence}
                  </span>
                )}
              </td>

              <td>
                <input
                  type="text"
                  inputMode="decimal"
                  className="cell-input"
                  aria-label={`${field.key} value`}
                  value={current}
                  placeholder="not found"
                  disabled={readOnly}
                  aria-invalid={problem ? true : undefined}
                  onChange={(e) => onEdit(field.key, e.target.value)}
                  onBlur={() => onCommit(field.key)}
                />

                <span className="readable">{shown ?? 'not found'}</span>

                {/* Their wording, not ours. It is their schema that refused. */}
                {problem && (
                  <span className="field-problem" role="alert">
                    {problem}
                  </span>
                )}

                {edited && !readOnly && (
                  <button className="link revert" onClick={() => onRevert(field.key)}>
                    revert
                  </button>
                )}
              </td>

              <td>
                {field.sourceText ? (
                  <>
                    <q className="source-text">{field.sourceText}</q>
                    {field.sourcePage !== null && (
                      <span className="subtle"> p.{field.sourcePage}</span>
                    )}
                  </>
                ) : (
                  <span className="subtle">—</span>
                )}
                <span className="reasoning subtle">{field.reasoning}</span>

                {/* A ratified lesson can move a value by a factor of a thousand.
                    Doing that without saying so would undo the point of asking
                    the analyst to ratify it in the first place. */}
                {field.lessonNote && (
                  <span className="lesson-note">
                    <strong>Applied what you confirmed.</strong> {field.lessonNote}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
