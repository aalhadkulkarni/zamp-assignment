import { useState } from 'react';
import {
  ApiError,
  WriteRejected,
  submitEdits,
  uploadDocuments,
  writeReport,
  type Fund,
} from './api';
import AnalysisList from './components/AnalysisList';
import NewAnalysis from './components/NewAnalysis';
import Workspace from './components/Workspace';
import type { Analysis, ChatMessage, EditEvent } from './types';
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
  const [writing, setWriting] = useState(false);

  function update(analysisId: string, change: (a: Analysis) => Analysis) {
    setAnalyses((current) => current.map((a) => (a.id === analysisId ? change(a) : a)));
  }

  function startAnalysis(fund: Fund) {
    const analysis: Analysis = {
      id: crypto.randomUUID(),
      fundId: fund.id,
      fundName: fund.name,
      createdAt: new Date().toISOString(),
      status: 'draft',
      messages: [message('agent', OPENING_MESSAGE)],
      fields: [],
      edits: {},
      editEvents: [],
      lessons: [],
      fiscalYearEnd: '',
      writeProblems: {},
    };

    setAnalyses((current) => [analysis, ...current]);
    setView({ name: 'analysis', id: analysis.id });
  }

  function setFields(analysisId: string, fields: Analysis['fields']) {
    // A new extraction is a fresh reading of the documents, so previous
    // corrections no longer refer to anything. Keeping them would silently
    // apply an old fix to a new value.
    setAnalyses((current) =>
      current.map((a) =>
        a.id === analysisId ? { ...a, fields, edits: {}, editEvents: [] } : a,
      ),
    );
  }

  /**
   * Called when the analyst leaves a field, not while they type. A correction is
   * one fact — that they changed this value to that one — and capturing it per
   * keystroke would turn typing a figure into a dozen of them.
   *
   * One event per field, replaced rather than appended. A field the analyst
   * tried three values in is one correction, and only where it ended up matters.
   * Nothing is written to the chat log here: pending corrections are current
   * state, and PendingEdits renders them from it.
   */
  function captureEdit(analysisId: string, key: string) {
    setAnalyses((current) =>
      current.map((a) => {
        if (a.id !== analysisId) return a;

        const field = a.fields.find((f) => f.key === key);
        if (!field) return a;

        const others = a.editEvents.filter((e) => e.fieldKey !== key);

        // Back to what the model said: not a correction, so not an event.
        if (!(key in a.edits)) return { ...a, editEvents: others };

        const event: EditEvent = {
          id: crypto.randomUUID(),
          fieldKey: key,
          from: field.value === null ? '' : String(field.value),
          to: a.edits[key],
          at: new Date().toISOString(),
          context: {
            sourceText: field.sourceText,
            sourcePage: field.sourcePage,
            confidence: field.confidence,
            reasoning: field.reasoning,
          },
        };

        return { ...a, editEvents: [...others, event] };
      }),
    );
  }

  function without(edits: Analysis['edits'], key: string): Analysis['edits'] {
    return Object.fromEntries(Object.entries(edits).filter(([edited]) => edited !== key));
  }

  /** What the model said, as text, for comparing against what the analyst typed. */
  function originalValue(analysis: Analysis, key: string): string {
    const field = analysis.fields.find((f) => f.key === key);
    return field?.value == null ? '' : String(field.value);
  }

  /**
   * Typing a value back to what the model said is not a correction, so it does
   * not get recorded as one. Kept canonical here rather than filtered in the
   * view: step 9 turns these into edit events, and a no-op edit would be sent
   * off for a diagnosis of a change that never happened.
   */
  function editField(analysisId: string, key: string, value: string) {
    setAnalyses((current) =>
      current.map((a) => {
        if (a.id !== analysisId) return a;
        // Any change clears the customer's complaint about that field. Leaving
        // it would keep flagging a value the analyst has already addressed.
        const writeProblems = without(a.writeProblems, key);
        return value.trim() === originalValue(a, key)
          ? { ...a, writeProblems, edits: without(a.edits, key) }
          : { ...a, writeProblems, edits: { ...a.edits, [key]: value } };
      }),
    );
  }

  /** Drops the correction entirely rather than writing the model's value back
   *  as an edit — an untouched field and a field corrected to its original
   *  value are the same thing, and neither is a correction. */
  function revertField(analysisId: string, key: string) {
    setAnalyses((current) =>
      current.map((a) => (a.id === analysisId ? { ...a, edits: without(a.edits, key) } : a)),
    );
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
  async function send(
    analysis: Analysis,
    text: string,
    files: File[],
  ): Promise<boolean> {
    const analysisId = analysis.id;
    try {
      const result = await uploadDocuments(analysisId, analysis.fundId, files, text);
      const analystMessage: ChatMessage = {
        ...message('analyst', text),
        attachments: files.map((f) => ({ name: f.name, size: f.size })),
      };

      // The documents are stored whether or not the model answered, so the
      // failure branch has to say that rather than reading like a lost upload.
      const agentMessage = result.agent
        ? { ...message('agent', result.agent.summary), fixture: result.agent.fixture }
        : {
            ...message(
              'agent',
              `Your ${result.documents.length === 1 ? 'document is' : 'documents are'} stored, ` +
                `but the assistant could not be reached. ${result.agentError?.message ?? ''}`.trim(),
            ),
            variant: 'error' as const,
          };

      append(analysisId, [analystMessage, agentMessage]);
      // Replaced wholesale rather than merged: a later upload is a fresh reading
      // of the documents, not an amendment to the previous one.
      if (result.agent) setFields(analysisId, result.agent.fields);
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

  /** The text currently on screen for every field: the analyst's if they
   *  corrected it, the model's otherwise. */
  function valuesFor(analysis: Analysis): Record<string, string> {
    return Object.fromEntries(
      analysis.fields.map((field) => [
        field.key,
        field.key in analysis.edits
          ? analysis.edits[field.key]
          : field.value === null
            ? ''
            : String(field.value),
      ]),
    );
  }

  /**
   * The customer's system is the source of truth, so a refusal is theirs to
   * explain. Their message goes into the chat unaltered and their per-field
   * complaints go onto the rows they name.
   */
  async function confirm(analysis: Analysis) {
    setWriting(true);
    try {
      await writeReport(
        analysis.id,
        analysis.fundId,
        analysis.fiscalYearEnd,
        valuesFor(analysis),
      );

      // Corrections go out only after the values were accepted. Learning from a
      // correction that was itself rejected would teach us the wrong thing.
      const corrections = analysis.editEvents;
      if (corrections.length > 0) {
        try {
          const result = await submitEdits(analysis.id, analysis.fundId, corrections);

          if (result.diagnosis) {
            update(analysis.id, (a) => ({ ...a, lessons: result.diagnosis!.lessons }));
            append(analysis.id, [message('agent', result.diagnosis.summary)]);
          } else if (result.error) {
            // The corrections are stored either way. Saying the write failed
            // would be wrong, and saying nothing would leave the analyst
            // wondering why nothing was asked about their edits.
            append(analysis.id, [
              {
                ...message(
                  'agent',
                  `Your corrections were recorded, but I could not work out why they were needed. ${result.error.message}`,
                ),
                variant: 'error',
              },
            ]);
          }
        } catch {
          append(analysis.id, [
            {
              ...message('agent', 'Your corrections could not be recorded for review.'),
              variant: 'error',
            },
          ]);
        }
      }

      update(analysis.id, (a) => ({ ...a, status: 'approved', writeProblems: {} }));
      append(analysis.id, [
        message(
          'agent',
          `Written to the customer's system for the period ending ${analysis.fiscalYearEnd}. ` +
            'This analysis is now read-only.' +
            (corrections.length > 0
              ? ` You corrected ${corrections.length} value${corrections.length === 1 ? '' : 's'}: ` +
                `${corrections.map((c) => c.fieldKey).join(', ')}.`
              : ''),
        ),
      ]);
    } catch (error) {
      if (error instanceof WriteRejected) {
        update(analysis.id, (a) => ({
          ...a,
          writeProblems: Object.fromEntries(error.problems.map((p) => [p.field, p.reason])),
        }));
      }
      const text =
        error instanceof Error ? error.message : 'The write failed for an unknown reason.';
      append(analysis.id, [{ ...message('agent', text), variant: 'error' }]);
    } finally {
      setWriting(false);
    }
  }

  /**
   * Nothing becomes a rule without this. The decision is recorded against the
   * lesson it belongs to, so that accepting one proposal never implies anything
   * about the others in the same batch.
   */
  function decideLesson(
    analysisId: string,
    lessonId: string,
    decision: 'accepted' | 'rejected',
    comment?: string,
  ) {
    update(analysisId, (a) => ({
      ...a,
      lessons: a.lessons.map((lesson) =>
        lesson.id === lessonId ? { ...lesson, decision, comment } : lesson,
      ),
    }));
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
          onSend={(text, files) => send(analysis, text, files)}
          onEdit={(key, value) => editField(analysis.id, key, value)}
          onCommit={(key) => captureEdit(analysis.id, key)}
          onRevert={(key) => revertField(analysis.id, key)}
          onPeriodChange={(fiscalYearEnd) =>
            update(analysis.id, (a) => ({ ...a, fiscalYearEnd }))
          }
          onAcceptLesson={(id) => decideLesson(analysis.id, id, 'accepted')}
          onRejectLesson={(id, comment) => decideLesson(analysis.id, id, 'rejected', comment)}
          onConfirm={() => confirm(analysis)}
          writing={writing}
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
