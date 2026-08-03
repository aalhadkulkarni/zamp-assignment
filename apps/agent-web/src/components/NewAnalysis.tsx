import { useEffect, useState } from 'react';
import { listFunds, type Fund } from '../api';

type Props = {
  onStart: (fund: Fund) => void;
  onCancel: () => void;
};

type Load =
  | { state: 'loading' }
  | { state: 'ready'; funds: Fund[] }
  | { state: 'failed'; message: string };

export default function NewAnalysis({ onStart, onCancel }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [fundId, setFundId] = useState('');

  useEffect(() => {
    let live = true;
    listFunds()
      .then((funds) => live && setLoad({ state: 'ready', funds }))
      .catch((error) => live && setLoad({ state: 'failed', message: error.message }));
    // Ignore a resolved request from an unmounted screen rather than warning.
    return () => {
      live = false;
    };
  }, []);

  const selected =
    load.state === 'ready' ? load.funds.find((fund) => fund.id === fundId) : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>New analysis</h1>
          <p className="subtle">
            Choose the fund you have been assigned. Its schema decides which values we
            look for.
          </p>
        </div>
      </header>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          if (selected) onStart(selected);
        }}
      >
        <label htmlFor="fund">Fund</label>

        {load.state === 'loading' && <p className="subtle">Loading funds…</p>}

        {load.state === 'failed' && (
          // The funds live in the customer's system. If it is unreachable, say
          // that rather than showing an empty dropdown that looks like no funds
          // exist.
          <p className="form-error" role="alert">
            {load.message}
          </p>
        )}

        {load.state === 'ready' && (
          <select id="fund" value={fundId} onChange={(e) => setFundId(e.target.value)}>
            <option value="">Select a fund…</option>
            {load.funds.map((fund) => (
              <option key={fund.id} value={fund.id}>
                {fund.issuer} — {fund.name}
              </option>
            ))}
          </select>
        )}

        <div className="form-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!selected}>
            Start analysis
          </button>
        </div>
      </form>
    </div>
  );
}
