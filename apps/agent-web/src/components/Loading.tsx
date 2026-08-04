/**
 * A spinner and a sentence saying what is being waited for.
 *
 * Drawn in CSS rather than shipped as a GIF: it inherits the current colour, so
 * it stays legible if the palette changes, and it costs no request. An animated
 * image would also keep spinning if the page froze, which is the one moment a
 * spinner most needs to be telling the truth.
 *
 * `role="status"` rather than `role="alert"` — a screen reader should mention
 * this when it gets to it, not interrupt whatever is being read.
 */
export default function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
