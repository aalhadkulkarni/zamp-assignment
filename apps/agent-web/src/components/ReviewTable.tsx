import type { ReviewField } from '../api';

type Props = {
  fields: ReviewField[];
};

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

export default function ReviewTable({ fields }: Props) {
  return (
    <table className="review-table">
      <thead>
        <tr>
          <th>Field</th>
          <th className="numeric">Value</th>
          <th>Source</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key} className={field.value === null ? 'row-blank' : undefined}>
            <td>
              <span className="field-key">{field.key}</span>
              <span className={`confidence confidence-${field.confidence}`}>
                {field.confidence}
              </span>
            </td>

            <td className="numeric">
              {field.value === null ? (
                <span className="subtle">not found</span>
              ) : (
                <>
                  <span className="value">{formatUsd(field.value)}</span>
                  {/* The analyst checks the printed figure against the page, then
                      checks that we scaled it correctly. Both have to be visible. */}
                  {field.unitsMultiplier !== 1 && (
                    <span className="units">
                      {field.valueAsPrinted?.toLocaleString('en-US')} ×{' '}
                      {field.unitsMultiplier.toLocaleString('en-US')}
                    </span>
                  )}
                </>
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
            </td>

            <td className="subtle">{field.reasoning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
