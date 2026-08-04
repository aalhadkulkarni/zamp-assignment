import type { AnalysisSummary } from '../api';
import Loading from './Loading';

type Props = {
  analyses: AnalysisSummary[];
  loading: boolean;
  failure: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function AnalysisList({ analyses, loading, failure, onOpen, onNew }: Props) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Analyses</h1>
          <p className="subtle">Pick up where you left off, or start on a new fund.</p>
        </div>
        {/* Available immediately. Starting a new analysis does not depend on
            knowing about the old ones, so waiting for that fetch would be an
            arbitrary delay. */}
        <button className="primary" onClick={onNew}>
          New analysis
        </button>
      </header>

      {/* An empty list because the server is unreachable is a different fact
          from having no analyses, and the difference matters to whoever is
          looking at it. */}
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}

      {/* "No analyses yet" is a statement about the server's answer, so it must
          not be shown before there is one. */}
      {loading ? (
        <div className="empty">
          <Loading label="Fetching your analyses…" />
        </div>
      ) : !failure && analyses.length === 0 ? (
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
