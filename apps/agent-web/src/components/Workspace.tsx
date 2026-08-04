import { useState } from 'react';
import type { StoredAnalysis } from '../api';
import type { EditEvent } from '../types';
import ChatPanel from './ChatPanel';
import Loading from './Loading';
import Composer from './Composer';
import LessonCard from './LessonCard';
import PendingEdits from './PendingEdits';
import ReviewTable from './ReviewTable';

type Props = {
  analysis: StoredAnalysis;
  edits: Record<string, string>;
  editEvents: EditEvent[];
  writeProblems: Record<string, string>;
  writing: boolean;
  failure: string | null;
  onSend: (text: string, files: File[]) => Promise<boolean>;
  onEdit: (key: string, value: string) => void;
  onCommit: (key: string) => void;
  onRevert: (key: string) => void;
  onConfirm: (fiscalYearEnd: string) => void;
  onAcceptLesson: (lessonId: string) => Promise<void>;
  onRejectLesson: (lessonId: string, comment: string) => Promise<void>;
  onBack: () => void;
};

export default function Workspace({
  analysis,
  edits,
  editEvents,
  writeProblems,
  writing,
  failure,
  onSend,
  onEdit,
  onCommit,
  onRevert,
  onConfirm,
  onAcceptLesson,
  onRejectLesson,
  onBack,
}: Props) {
  const approved = analysis.status === 'approved';
  const reading = analysis.extraction.state === 'running';
  const explaining = analysis.diagnosis.state === 'running';
  const [fiscalYearEnd, setFiscalYearEnd] = useState(analysis.fiscalYearEnd);
  const editCount = Object.keys(edits).length;

  // Decided cards stay, showing what was decided. Removing them on click would
  // leave the analyst with no sign that anything happened, and no record of
  // what they agreed to.
  const lessons = analysis.lessons;

  return (
    <div className="workspace">
      <header className="workspace-header">
        <button className="link" onClick={onBack}>
          ← Analyses
        </button>
        <h1>{analysis.fundName}</h1>
        <span className={`badge badge-${analysis.status}`}>{analysis.status}</span>
      </header>

      <div className="workspace-body">
        <section className="chat" aria-label="Agent conversation">
          <ChatPanel messages={analysis.messages} />

          {/* Where the agent's reply will appear, standing in for it until it
              does. The upload was answered seconds ago; without this the chat
              would sit unchanged for the length of a model call and look like
              nothing had happened. */}
          {reading && (
            <div className="agent-working">
              <Loading label="Reading your documents. This usually takes under a minute." />
            </div>
          )}

          {/* The write has already been confirmed by this point. What is still
              running is the explanation, and saying so is what stops the
              proposal appearing out of nowhere a minute later. */}
          {explaining && (
            <div className="agent-working">
              <Loading label="Working out what caused those corrections…" />
            </div>
          )}

          {failure && (
            <p className="form-error chat-failure" role="alert">
              {failure}
            </p>
          )}

          {lessons.length > 0 && (
            <section className="lessons" aria-label="Proposed lessons">
              {lessons.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  onAccept={onAcceptLesson}
                  onReject={onRejectLesson}
                />
              ))}
            </section>
          )}

          {!approved && <PendingEdits edits={editEvents} />}
          {/* A second upload while the first is still being read would be
              refused by the server anyway. Saying so here is kinder than
              letting them find out. */}
          <Composer onSend={onSend} disabled={reading} disabledReason="The agent is still reading your last upload." />
        </section>

        <section className="review" aria-label="Extracted values">
          {analysis.fields.length === 0 && reading ? (
            <div className="empty">
              <Loading label="Looking for the values your schema asks for…" />
            </div>
          ) : analysis.fields.length === 0 ? (
            <div className="empty">
              <p>No values yet.</p>
              <p className="subtle">
                Extracted values will appear here for review, with the source page and
                reasoning behind each one.
              </p>
            </div>
          ) : (
            <>
              <ReviewTable
                fields={analysis.fields}
                edits={edits}
                problems={writeProblems}
                readOnly={approved}
                onEdit={onEdit}
                onCommit={onCommit}
                onRevert={onRevert}
              />

              {/* Sticky, because the table scrolls and the decision to write
                  should not require scrolling to find. */}
              <div className="review-actions">
                {approved ? (
                  <p className="subtle">
                    Read-only. The customer's database owns these values now.
                  </p>
                ) : (
                  <>
                    <div className="period">
                      <label htmlFor="fiscal-year-end">Period ending</label>
                      <input
                        id="fiscal-year-end"
                        type="date"
                        value={fiscalYearEnd}
                        onChange={(e) => setFiscalYearEnd(e.target.value)}
                      />
                    </div>

                    <p className="subtle">
                      {editCount === 0
                        ? 'Nothing changed yet.'
                        : `${editCount} value${editCount === 1 ? '' : 's'} corrected.`}
                    </p>

                    <button
                      className="primary"
                      onClick={() => onConfirm(fiscalYearEnd)}
                      // The period is the customer's uniqueness key. Writing
                      // without it would be refused anyway, and less clearly.
                      disabled={writing || fiscalYearEnd === ''}
                    >
                      {writing ? 'Writing…' : 'Confirm and write'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
