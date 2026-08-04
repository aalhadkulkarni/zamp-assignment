import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  WriteRejected,
  createAnalysis,
  decideLesson,
  getAnalysis,
  listAnalyses,
  listFieldDefinitions,
  submitEdits,
  uploadDocuments,
  watchAnalysis,
  writeReport,
  type AnalysisSummary,
  type Fund,
  type StoredAnalysis,
} from './api';
import AnalysisList from './components/AnalysisList';
import Loading from './components/Loading';
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
  /**
   * Starts true. An empty list and a list not yet fetched look identical, and
   * "No analyses yet" is a claim we cannot make until the server has answered.
   */
  const [listLoading, setListLoading] = useState(true);
  /**
   * The customer's own names for their own fields, fetched once. Falls back to
   * the key, so a customer-system that is unreachable costs a nicer label and
   * nothing else.
   */
  const [labels, setLabels] = useState<Record<string, string>>({});
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

  // No spinner here: this runs after an action the analyst has already been
  // given feedback for, and flipping the list to a loading state behind them
  // would be movement without information.
  const refreshList = useCallback(async () => {
    try {
      setAnalyses(await listAnalyses());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not load analyses.');
    }
  }, []);

  /**
   * Counts reads so a slow one cannot overwrite a newer answer.
   *
   * Four things call `load`, and two of them routinely overlap: `confirm` reads
   * the analysis back after submitting corrections, and the event stream reads
   * it again the moment the diagnosis finishes. Both end in `setCurrent`, so
   * whichever *resolves* last wins — not whichever was asked last. When the
   * diagnosis is quick the second read returns first, the first read lands after
   * it holding the older snapshot, and the analysis reverts to "still working
   * it out" with no further event coming to correct it. The spinner then turns
   * forever over work that finished.
   */
  const reads = useRef(0);

  const load = useCallback(async (analysisId: string) => {
    const read = (reads.current += 1);
    try {
      const analysis = await getAnalysis(analysisId);
      // A newer read has already answered, so this one is history.
      if (read !== reads.current) return;
      setCurrent(analysis);
      setFailure(null);
    } catch (error) {
      if (read !== reads.current) return;
      setFailure(error instanceof Error ? error.message : 'Could not load that analysis.');
    }
  }, []);

  useEffect(() => {
    let live = true;
    listFieldDefinitions()
      .then((definitions) => {
        if (live) setLabels(Object.fromEntries(definitions.map((d) => [d.key, d.label])));
      })
      // Deliberately swallowed. Labels are presentation; the analysis is not.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Fetched in a callback rather than set synchronously, which is the shape the
  // effect rules want and avoids a cascading render on mount.
  useEffect(() => {
    let live = true;
    listAnalyses()
      .then((rows) => live && setAnalyses(rows))
      .catch((error) => live && setFailure(error.message))
      .finally(() => live && setListLoading(false));
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

  /**
   * Awaited by the form, which keeps its button in a pending state until this
   * settles. Throwing rather than swallowing is what lets it stop waiting when
   * the analysis could not be created.
   */
  async function startAnalysis(fund: Fund) {
    setFailure(null);
    const created = await createAnalysis(fund.id);

    // The analysis exists, so navigate now and let the workspace show its own
    // loading state. Waiting for the fetch before switching screens would leave
    // the analyst on a form whose button did nothing.
    setView({ name: 'analysis', id: created.id });
    await Promise.all([load(created.id), refreshList()]);
  }

  /**
   * Watches the open analysis for changes the browser did not cause.
   *
   * The extraction runs after its upload has already been answered, so the only
   * way its result arrives is this. Re-reading the whole analysis on every event
   * is deliberate — the event says something moved, not what, and one fetch is
   * cheaper than two representations that can disagree.
   */
  useEffect(() => {
    if (view.name !== 'analysis') return;
    return watchAnalysis(view.id, () => void load(view.id));
  }, [view, load]);

  async function send(text: string, files: File[]): Promise<boolean> {
    if (!current) return false;
    try {
      await uploadDocuments(current.id, current.fundId, files, text);
      // The upload is accepted, not finished. This re-read picks up the
      // analyst's own message and the extraction now marked as running; the
      // result itself arrives later, over the event stream.
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
      //
      // This returns as soon as the corrections are stored. Working out what
      // caused them is a model call, and holding the button through it would put
      // the analyst back where they were before the write was split out — except
      // now waiting on something they have already been told succeeded.
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

  /**
   * Navigated to an analysis we do not hold yet.
   *
   * This branch used to be missing, and the render fell through to the list —
   * so starting an analysis showed the list for as long as the fetch took,
   * which read as the click having failed and then a redirect. The analyst has
   * asked for a specific screen; the honest answer is that screen, loading.
   */
  if (view.name === 'analysis' && current?.id !== view.id) {
    return (
      <div className="page">
        {failure ? (
          <>
            <p className="form-error" role="alert">
              {failure}
            </p>
            <button onClick={() => setView({ name: 'list' })}>← Analyses</button>
          </>
        ) : (
          <div className="loading-page">
            <Loading label="Opening the analysis…" />
          </div>
        )}
      </div>
    );
  }

  if (view.name === 'analysis' && current) {
    return (
      <Workspace
        analysis={current}
        labels={labels}
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
      loading={listLoading}
      failure={failure}
      onOpen={(id) => {
        setFailure(null);
        setView({ name: 'analysis', id });
        void load(id);
      }}
      onNew={() => setView({ name: 'new' })}
    />
  );
}
