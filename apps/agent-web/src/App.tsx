import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  WriteRejected,
  createAnalysis,
  decideLesson,
  getAnalysis,
  listAnalyses,
  submitEdits,
  uploadDocuments,
  writeReport,
  type AnalysisSummary,
  type Fund,
  type StoredAnalysis,
} from './api';
import AnalysisList from './components/AnalysisList';
import NewAnalysis from './components/NewAnalysis';
import Workspace from './components/Workspace';
import type { EditEvent } from './types';
import './App.css';

/**
 * Two screens and a workspace is still not enough to justify a router. An
 * analysis now has a server-side identity, so a shareable URL has become
 * possible — that is the point to add one, and it has not arrived yet.
 */
type View = { name: 'list' } | { name: 'new' } | { name: 'analysis'; id: string };

export default function App() {
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [current, setCurrent] = useState<StoredAnalysis | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [writing, setWriting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [writeProblems, setWriteProblems] = useState<Record<string, string>>({});

  /**
   * The only client-side state left: corrections the analyst is part-way
   * through. They are not corrections until submitted, and losing a half-typed
   * value on refresh is what every form does. Everything else lives on the
   * server, which is why a refresh no longer destroys an analysis.
   */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editEvents, setEditEvents] = useState<EditEvent[]>([]);

  const refreshList = useCallback(async () => {
    try {
      setAnalyses(await listAnalyses());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not load analyses.');
    }
  }, []);

  const load = useCallback(async (analysisId: string) => {
    try {
      setCurrent(await getAnalysis(analysisId));
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not load that analysis.');
    }
  }, []);

  // Fetched in a callback rather than set synchronously, which is the shape the
  // effect rules want and avoids a cascading render on mount.
  useEffect(() => {
    let live = true;
    listAnalyses()
      .then((rows) => live && setAnalyses(rows))
      .catch((error) => live && setFailure(error.message));
    return () => {
      live = false;
    };
  }, []);

  function originalValue(key: string): string {
    const field = current?.fields.find((f) => f.key === key);
    return field?.value == null ? '' : String(field.value);
  }

  /** Typing a value back to what the model said is not a correction. */
  function editField(key: string, value: string) {
    setWriteProblems((problems) =>
      Object.fromEntries(Object.entries(problems).filter(([k]) => k !== key)),
    );
    setEdits((currentEdits) =>
      value.trim() === originalValue(key)
        ? Object.fromEntries(Object.entries(currentEdits).filter(([k]) => k !== key))
        : { ...currentEdits, [key]: value },
    );
  }

  function revertField(key: string) {
    setEdits((currentEdits) =>
      Object.fromEntries(Object.entries(currentEdits).filter(([k]) => k !== key)),
    );
    setEditEvents((events) => events.filter((e) => e.fieldKey !== key));
  }

  /**
   * On blur, not on change — typing a figure would otherwise be a dozen
   * corrections. One event per field, replaced rather than appended, because a
   * field the analyst tried three values in is one correction.
   */
  function captureEdit(key: string) {
    const field = current?.fields.find((f) => f.key === key);
    if (!field) return;

    setEditEvents((events) => {
      const others = events.filter((e) => e.fieldKey !== key);
      if (!(key in edits)) return others;

      return [
        ...others,
        {
          id: crypto.randomUUID(),
          fieldKey: key,
          from: field.value === null ? '' : String(field.value),
          to: edits[key],
          at: new Date().toISOString(),
          context: {
            sourceText: field.sourceText,
            sourcePage: field.sourcePage,
            confidence: field.confidence,
            reasoning: field.reasoning,
          },
        },
      ];
    });
  }

  async function startAnalysis(fund: Fund) {
    try {
      const created = await createAnalysis(fund.id);
      setView({ name: 'analysis', id: created.id });
      await Promise.all([load(created.id), refreshList()]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not start an analysis.');
    }
  }

  async function send(text: string, files: File[]): Promise<boolean> {
    if (!current) return false;
    try {
      await uploadDocuments(current.id, current.fundId, files, text);
      // The server wrote the conversation and the values. Re-read them rather
      // than assembling a second copy here that could drift from it.
      await load(current.id);
      setEdits({});
      setEditEvents([]);
      return true;
    } catch (error) {
      // Which document was refused, and why. Collapsing that to "upload failed"
      // makes the analyst guess which of five files to look at.
      const detail =
        error instanceof ApiError && error.rejected?.length
          ? ` ${error.rejected.map((r) => `${r.filename}: ${r.reason}`).join('; ')}`
          : '';
      setFailure(
        (error instanceof ApiError ? error.message : 'Upload failed.') + detail,
      );
      return false;
    }
  }

  function valuesFor(analysis: StoredAnalysis): Record<string, string> {
    return Object.fromEntries(
      analysis.fields.map((field) => [
        field.key,
        field.key in edits ? edits[field.key] : field.value === null ? '' : String(field.value),
      ]),
    );
  }

  async function confirm(fiscalYearEnd: string) {
    if (!current) return;
    setWriting(true);
    try {
      await writeReport(current.id, current.fundId, fiscalYearEnd, valuesFor(current));
      setWriteProblems({});
      setFailure(null);

      // Only once the values were accepted. Learning from a correction that was
      // itself rejected would teach us the wrong thing.
      if (editEvents.length > 0) {
        await submitEdits(current.id, current.fundId, editEvents);
      }

      setEdits({});
      setEditEvents([]);
      await Promise.all([load(current.id), refreshList()]);
    } catch (error) {
      if (error instanceof WriteRejected) {
        setWriteProblems(Object.fromEntries(error.problems.map((p) => [p.field, p.reason])));
      }
      setFailure(error instanceof Error ? error.message : 'The write failed.');
    } finally {
      setWriting(false);
    }
  }

  async function decide(lessonId: string, decision: 'accepted' | 'rejected', comment?: string) {
    if (!current) return;
    try {
      await decideLesson(current.id, lessonId, decision, comment);
      await load(current.id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not record that decision.');
    }
  }

  if (view.name === 'new') {
    return <NewAnalysis onStart={startAnalysis} onCancel={() => setView({ name: 'list' })} />;
  }

  if (view.name === 'analysis' && current?.id === view.id) {
    return (
      <Workspace
        analysis={current}
        edits={edits}
        editEvents={editEvents}
        writeProblems={writeProblems}
        writing={writing}
        failure={failure}
        onSend={send}
        onEdit={editField}
        onCommit={captureEdit}
        onRevert={revertField}
        onConfirm={confirm}
        onAcceptLesson={(id) => decide(id, 'accepted')}
        onRejectLesson={(id, comment) => decide(id, 'rejected', comment)}
        onBack={() => {
          setCurrent(null);
          setEdits({});
          setEditEvents([]);
          setView({ name: 'list' });
        }}
      />
    );
  }

  return (
    <AnalysisList
      analyses={analyses}
      failure={failure}
      onOpen={(id) => {
        setView({ name: 'analysis', id });
        void load(id);
      }}
      onNew={() => setView({ name: 'new' })}
    />
  );
}
