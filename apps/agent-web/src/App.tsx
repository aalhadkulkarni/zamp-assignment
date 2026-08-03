import { useState } from 'react';
import { ApiError, uploadDocuments, type Fund } from './api';
import AnalysisList from './components/AnalysisList';
import NewAnalysis from './components/NewAnalysis';
import Workspace from './components/Workspace';
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

  function startAnalysis(fund: Fund) {
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

  function append(analysisId: string, added: ChatMessage[]) {
    setAnalyses((current) =>
      current.map((a) =>
        a.id === analysisId ? { ...a, messages: [...a.messages, ...added] } : a,
      ),
    );
  }

  /**
   * Nothing is written to the log until the upload comes back. On failure the
   * only new message is the error, and the composer keeps the documents, so
   * retrying does not leave a half-sent message behind.
   */
  async function send(analysisId: string, text: string, files: File[]): Promise<boolean> {
    try {
      const result = await uploadDocuments(analysisId, files, text);
      const analystMessage: ChatMessage = {
        ...message('analyst', text),
        attachments: files.map((f) => ({ name: f.name, size: f.size })),
      };

      // The documents are stored whether or not the model answered, so the
      // failure branch has to say that rather than reading like a lost upload.
      const agentMessage = result.agent
        ? { ...message('agent', result.agent.text), fixture: result.agent.fixture }
        : {
            ...message(
              'agent',
              `Your ${result.documents.length === 1 ? 'document is' : 'documents are'} stored, ` +
                `but the assistant could not be reached. ${result.agentError?.message ?? ''}`.trim(),
            ),
            variant: 'error' as const,
          };

      append(analysisId, [analystMessage, agentMessage]);
      return true;
    } catch (error) {
      const detail =
        error instanceof ApiError && error.rejected?.length
          ? ` ${error.rejected.map((r) => `${r.filename}: ${r.reason}`).join('; ')}`
          : '';
      const text = error instanceof ApiError ? error.message : 'Upload failed.';

      append(analysisId, [{ ...message('agent', text + detail), variant: 'error' }]);
      return false;
    }
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
