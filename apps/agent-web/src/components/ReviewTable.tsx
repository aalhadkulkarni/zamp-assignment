import type { ReviewField } from '../api';
import type { FieldEdit } from '../types';

type Props = {
  fields: ReviewField[];
  edits: Record<string, FieldEdit>;
  onEdit: (key: string, edit: FieldEdit) => void;
  onRevert: (key: string) => void;
};

/** What the document says its figures are in. Covers every ACFR I have seen. */
const MULTIPLIERS = [
  { value: 1, label: 'as printed' },
  { value: 1000, label: 'thousands' },
  { value: 1_000_000, label: 'millions' },
];

/**
 * Whole dollars, grouped, no decimals. These are billions — cents are noise, and
 * an abbreviated "$462.1B" would hide the digit an analyst is checking against
 * the document.
 */
function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export default function ReviewTable({ fields, edits, onEdit, onRevert }: Props) {
  return (
    <table className="review-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Figure</th>
          <th>Units</th>
          <th className="numeric">Value</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          // The analyst's version if they have touched it, the model's otherwise.
          const current = edits[field.key] ?? {
            valueAsPrinted: field.valueAsPrinted,
            unitsMultiplier: field.unitsMultiplier,
          };
          const edited = field.key in edits;
          const value =
            current.valueAsPrinted === null
              ? null
              : Math.round(current.valueAsPrinted * current.unitsMultiplier);

          return (
            <tr
              key={field.key}
              className={[
                value === null ? 'row-blank' : '',
                edited ? 'row-edited' : '',
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
                  type="number"
                  className="cell-input"
                  aria-label={`${field.key} figure`}
                  value={current.valueAsPrinted ?? ''}
                  placeholder="not found"
                  onChange={(e) =>
                    onEdit(field.key, {
                      ...current,
                      valueAsPrinted: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </td>

              <td>
                {/* Separate from the figure on purpose: changing this is a units
                    correction, and that is a different lesson from a mis-read. */}
                <select
                  className="cell-input"
                  aria-label={`${field.key} units`}
                  value={current.unitsMultiplier}
                  onChange={(e) =>
                    onEdit(field.key, { ...current, unitsMultiplier: Number(e.target.value) })
                  }
                >
                  {MULTIPLIERS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </td>

              <td className="numeric">
                {value === null ? (
                  <span className="subtle">not found</span>
                ) : (
                  <span className="value">{formatUsd(value)}</span>
                )}
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
