import { useEffect, useState } from 'react';

const AGENT_API = import.meta.env.VITE_AGENT_API_URL ?? 'http://localhost:3001';
const CUSTOMER_SYSTEM = import.meta.env.VITE_CUSTOMER_SYSTEM_URL ?? 'http://localhost:3002';

type Status = { ok: boolean; service: string } | { error: string } | null;

function useHealth(baseUrl: string) {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    fetch(`${baseUrl}/health`)
      .then((r) => r.json())
      .then(setStatus)
      .catch((e) => setStatus({ error: String(e) }));
  }, [baseUrl]);
  return status;
}

export default function App() {
  const agent = useHealth(AGENT_API);
  const customer = useHealth(CUSTOMER_SYSTEM);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>zamp-assignment</h1>
      <ul>
        <li>agent-api: {agent ? JSON.stringify(agent) : 'checking…'}</li>
        <li>customer-system: {customer ? JSON.stringify(customer) : 'checking…'}</li>
      </ul>
    </main>
  );
}