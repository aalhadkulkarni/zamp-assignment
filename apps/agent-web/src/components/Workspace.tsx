import ChatPanel from './ChatPanel';
import ReviewTable from './ReviewTable';
import Composer from './Composer';
import type { Analysis } from '../types';

type Props = {
  analysis: Analysis;
  onSend: (text: string, files: File[]) => Promise<boolean>;
  onEdit: (key: string, value: string) => void;
  onRevert: (key: string) => void;
  onConfirm: () => void;
  onBack: () => void;
};

export default function Workspace({
  analysis,
  onSend,
  onEdit,
  onRevert,
  onConfirm,
  onBack,
}: Props) {
  const editCount = Object.keys(analysis.edits).length;

  return (
    <div className="workspace">
      <header className="workspace-header">
        <button className="link" onClick={onBack}>
          ← Analyses
        </button>
        <h1>{analysis.fundName}</h1>
        <span className={`badge badge-${analysis.status}`}>{analysis.status}</span>
      </header>

      <div className="workspace-body">
        <section className="chat" aria-label="Agent conversation">
          <ChatPanel messages={analysis.messages} />
          <Composer onSend={onSend} />
        </section>

        <section className="review" aria-label="Extracted values">
          {analysis.fields.length === 0 ? (
            <div className="empty">
              <p>No values yet.</p>
              <p className="subtle">
                Extracted values will appear here for review, with the source page and
                reasoning behind each one.
              </p>
            </div>
          ) : (
            <>
              <ReviewTable
                fields={analysis.fields}
                edits={analysis.edits}
                onEdit={onEdit}
                onRevert={onRevert}
              />

              {/* Sticky, because the table scrolls and the decision to write
                  should not require scrolling to find. */}
              <div className="review-actions">
                <p className="subtle">
                  {editCount === 0
                    ? 'Nothing changed yet.'
                    : `${editCount} value${editCount === 1 ? '' : 's'} corrected.`}
                </p>
                <button className="primary" onClick={onConfirm}>
                  Confirm and write
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
