import ChatPanel from './ChatPanel';
import Composer from './Composer';
import type { Analysis } from '../types';

type Props = {
  analysis: Analysis;
  onSend: (text: string, files: File[]) => Promise<boolean>;
  onBack: () => void;
};

export default function Workspace({ analysis, onSend, onBack }: Props) {
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
          <div className="empty">
            <p>No values yet.</p>
            <p className="subtle">
              Extracted values will appear here for review, with the source page and
              reasoning behind each one.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
