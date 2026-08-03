import type { ReviewField } from '../api';

type Props = {
  fields: ReviewField[];
  edits: Record<string, string>;
  onEdit: (key: string, value: string) => void;
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

export default function ReviewTable({ fields, edits, onEdit, onRevert }: Props) {
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

          return (
            <tr
              key={field.key}
              className={[shown === null ? 'row-blank' : '', edited ? 'row-edited' : '']
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
                  onChange={(e) => onEdit(field.key, e.target.value)}
                />

                <span className="readable">{shown ?? 'not found'}</span>

                {edited && (
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
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
