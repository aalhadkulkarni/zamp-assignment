import { useState } from 'react';
import AnalysisList from './components/AnalysisList';
import NewAnalysis from './components/NewAnalysis';
import Workspace from './components/Workspace';
import { formatBytes } from './files';
import { FUNDS } from './funds';
import type { Analysis, ChatMessage } from './types';
import './App.css';

/**
 * Two screens and a workspace is not enough to justify a router. When analyses
 * are persisted server-side they will need shareable URLs, and that is the point
 * to add one — not before.
 */
type View = { name: 'list' } | { name: 'new' } | { name: 'analysis'; id: string };

const OPENING_MESSAGE =
  'Upload the documents you want analysed. You can add context in the message box — ' +
  'for example, which table to use, or whether figures are reported in thousands.';

function message(author: ChatMessage['author'], text: string): ChatMessage {
  return { id: crypto.randomUUID(), author, text };
}

export default function App() {
  // In-memory for now. Analyses move to agent-api when there is a backend to hold them.
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [view, setView] = useState<View>({ name: 'list' });

  function startAnalysis(fundId: string) {
    const fund = FUNDS.find((f) => f.id === fundId);
    if (!fund) return;

    const analysis: Analysis = {
      id: crypto.randomUUID(),
      fundId: fund.id,
      fundName: fund.name,
      createdAt: new Date().toISOString(),
      status: 'draft',
      messages: [message('agent', OPENING_MESSAGE)],
    };

    setAnalyses((current) => [analysis, ...current]);
    setView({ name: 'analysis', id: analysis.id });
  }

  /**
   * Slice 1 stops here: we confirm what we received and send nothing anywhere.
   * The upload request replaces the confirmation in the next slice.
   */
  function send(analysisId: string, text: string, files: File[]) {
    const attachments = files.map((f) => ({ name: f.name, size: f.size }));
    const received = files
      .map((f) => `${f.name} (${formatBytes(f.size)})`)
      .join(', ');

    const analystMessage: ChatMessage = {
      ...message('analyst', text),
      attachments,
    };
    const agentMessage = message(
      'agent',
      `Received ${files.length} ${files.length === 1 ? 'document' : 'documents'}: ${received}. ` +
        'Nothing has been sent to the server yet.',
    );

    setAnalyses((current) =>
      current.map((a) =>
        a.id === analysisId
          ? { ...a, messages: [...a.messages, analystMessage, agentMessage] }
          : a,
      ),
    );
  }

  if (view.name === 'new') {
    return <NewAnalysis onStart={startAnalysis} onCancel={() => setView({ name: 'list' })} />;
  }

  if (view.name === 'analysis') {
    const analysis = analyses.find((a) => a.id === view.id);
    if (analysis) {
      return (
        <Workspace
          analysis={analysis}
          onSend={(text, files) => send(analysis.id, text, files)}
          onBack={() => setView({ name: 'list' })}
        />
      );
    }
  }

  return (
    <AnalysisList
      analyses={analyses}
      onOpen={(id) => setView({ name: 'analysis', id })}
      onNew={() => setView({ name: 'new' })}
    />
  );
}
