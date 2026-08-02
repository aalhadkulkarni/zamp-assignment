import { useState } from 'react';
import { FUNDS } from '../funds';

type Props = {
  onStart: (fundId: string) => void;
  onCancel: () => void;
};

export default function NewAnalysis({ onStart, onCancel }: Props) {
  const [fundId, setFundId] = useState('');

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
          if (fundId) onStart(fundId);
        }}
      >
        <label htmlFor="fund">Fund</label>
        <select id="fund" value={fundId} onChange={(e) => setFundId(e.target.value)}>
          <option value="">Select a fund…</option>
          {FUNDS.map((fund) => (
            <option key={fund.id} value={fund.id}>
              {fund.name}
            </option>
          ))}
        </select>

        <div className="form-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!fundId}>
            Start analysis
          </button>
        </div>
      </form>
    </div>
  );
}
