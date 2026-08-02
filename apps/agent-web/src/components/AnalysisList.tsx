import type { Analysis } from '../types';

type Props = {
  analyses: Analysis[];
  onOpen: (id: string) => void;
  onNew: () => void;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function AnalysisList({ analyses, onOpen, onNew }: Props) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Analyses</h1>
          <p className="subtle">Pick up where you left off, or start on a new fund.</p>
        </div>
        <button className="primary" onClick={onNew}>
          New analysis
        </button>
      </header>

      {analyses.length === 0 ? (
        <div className="empty">
          <p>No analyses yet.</p>
          <p className="subtle">Start one to upload documents and review extracted values.</p>
        </div>
      ) : (
        <ul className="analysis-list">
          {analyses.map((analysis) => (
            <li key={analysis.id}>
              <button className="analysis-row" onClick={() => onOpen(analysis.id)}>
                <span className="analysis-fund">{analysis.fundName}</span>
                <span className="analysis-meta">
                  <span className={`badge badge-${analysis.status}`}>{analysis.status}</span>
                  <span className="subtle">{formatDate(analysis.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
