import { useEffect, useState } from 'react';
import { listFunds, type Fund } from '../api';
import Loading from './Loading';

type Props = {
  /** Awaited, so the button can stay pending until the analysis exists. */
  onStart: (fund: Fund) => Promise<void>;
  onCancel: () => void;
};

type Load =
  | { state: 'loading' }
  | { state: 'ready'; funds: Fund[] }
  | { state: 'failed'; message: string };

export default function NewAnalysis({ onStart, onCancel }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [fundId, setFundId] = useState('');
  /**
   * Creating the analysis is a round trip before there is anything to navigate
   * to. Without this the button sits enabled and unchanged while it happens,
   * which invites a second click and a second analysis.
   */
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<string | null>(null);

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
        onSubmit={async (e) => {
          e.preventDefault();
          if (!selected || starting) return;

          setStarting(true);
          setStartFailure(null);
          try {
            await onStart(selected);
          } catch (error) {
            // Staying on this screen with the reason beats being dropped back
            // to the list having lost the fund that was picked.
            setStartFailure(
              error instanceof Error ? error.message : 'Could not start an analysis.',
            );
            setStarting(false);
          }
          // Deliberately not cleared on success: this screen is being replaced,
          // and re-enabling the button first would flash it back to ready.
        }}
      >
        <label htmlFor="fund">Fund</label>

        {load.state === 'loading' && <Loading label="Loading funds…" />}

        {load.state === 'failed' && (
          // The funds live in the customer's system. If it is unreachable, say
          // that rather than showing an empty dropdown that looks like no funds
          // exist.
          <p className="form-error" role="alert">
            {load.message}
          </p>
        )}

        {load.state === 'ready' && (
          <select
            id="fund"
            value={fundId}
            onChange={(e) => setFundId(e.target.value)}
            disabled={starting}
          >
            <option value="">Select a fund…</option>
            {load.funds.map((fund) => (
              <option key={fund.id} value={fund.id}>
                {fund.name}
              </option>
            ))}
          </select>
        )}

        {startFailure && (
          <p className="form-error" role="alert">
            {startFailure}
          </p>
        )}

        <div className="form-actions">
          <button type="button" onClick={onCancel} disabled={starting}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!selected || starting}>
            {starting ? 'Starting…' : 'Start analysis'}
          </button>
        </div>
      </form>
    </div>
  );
}
