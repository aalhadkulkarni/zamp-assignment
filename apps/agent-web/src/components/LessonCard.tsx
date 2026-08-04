import { useState } from 'react';
import type { Lesson, LessonScope, LessonType } from '../api';
import { readable } from '../format';

type Props = {
  lesson: Lesson;
  /** Awaited, so the card can show that the decision is being recorded. */
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string, comment: string) => Promise<void>;
};

/** What each type means, in the analyst's language rather than ours. */
const TYPE_LABEL: Record<LessonType, string> = {
  typo: 'A one-off slip',
  wrong_source: 'Read from the wrong place',
  units: 'Wrong units',
  concept_confusion: 'Wrong concept',
  synonym: 'Label not recognised',
};

/**
 * The scope is the consequential part. "Every document from every fund" is a
 * much bigger claim than "this once", and the analyst is being asked to ratify
 * exactly that — so it is stated in full rather than as a one-word tag.
 */
const SCOPE_LABEL: Record<LessonScope, string> = {
  none: 'Applies to this document only — nothing will be remembered',
  fund: 'Would apply to every future document from this fund',
  global: 'Would apply to every document from every fund',
};

export default function LessonCard({ lesson, onAccept, onReject }: Props) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  /**
   * A decision is a round trip, and this one is consequential — it is what makes
   * a rule apply to every future document from this fund. A button that looks
   * unchanged after being pressed invites a second press.
   */
  const [saving, setSaving] = useState(false);

  async function decide(record: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    try {
      await record();
    } finally {
      // Released either way. On success the card re-renders as decided and the
      // buttons go with it; on failure they have to work again.
      setSaving(false);
    }
  }

  if (lesson.decision === 'accepted') {
    return (
      <div className="lesson lesson-accepted">
        <p className="lesson-resolved">Accepted — {lesson.rule || 'nothing to remember.'}</p>
      </div>
    );
  }

  if (lesson.decision === 'rejected') {
    return (
      <div className="lesson lesson-rejected">
        <p className="lesson-resolved">Rejected.</p>
        {lesson.comment && <p className="lesson-comment">You said: {lesson.comment}</p>}
      </div>
    );
  }

  return (
    <div className={`lesson lesson-${lesson.scope}`}>
      <div className="lesson-head">
        <span className="lesson-type">{TYPE_LABEL[lesson.type]}</span>
        <span className="lesson-confidence subtle">{lesson.confidence} confidence</span>
      </div>

      <p className="lesson-explanation">{lesson.explanation}</p>

      {lesson.rule && <p className="lesson-rule">Next time: {lesson.rule}</p>}

      <p className="lesson-scope">{SCOPE_LABEL[lesson.scope]}</p>

      {/* The evidence, on the card being ratified. A proposal that names a
          field without saying what happened to it asks the analyst to agree to
          a rule while going elsewhere to check what it is about. */}
      {lesson.corrections.length > 0 ? (
        <ul className="lesson-corrections">
          {lesson.corrections.map((correction) => (
            <li key={correction.fieldKey}>
              <span className="correction-field">{correction.fieldKey}</span>
              <span className="correction-change">
                {readable(correction.from)} → {readable(correction.to)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        lesson.fieldKey && <p className="lesson-fields subtle">{lesson.fieldKey}</p>
      )}

      {/* Said, not acted on. The agent thinks these moved for the same reason,
          and that is worth knowing — but each is decided on its own card, so
          agreeing here does not commit the analyst to agreeing there. */}
      {lesson.sharedWith.length > 0 && (
        <p className="lesson-shared subtle">
          Looks like the same cause as {lesson.sharedWith.join(', ')} — decided separately.
        </p>
      )}

      {rejecting ? (
        // The comment belongs on the lesson it refutes, not in the chat box.
        // Typed loose, it would have to be matched back to a lesson by guessing
        // — which is the problem this whole feature exists to avoid.
        <div className="lesson-reject">
          <label htmlFor={`why-${lesson.id}`}>What actually happened?</label>
          <textarea
            id={`why-${lesson.id}`}
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="The figures were already in whole dollars on that page."
          />
          <div className="lesson-actions">
            <button onClick={() => setRejecting(false)} disabled={saving}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => decide(() => onReject(lesson.id, comment.trim()))}
              disabled={comment.trim() === '' || saving}
            >
              {saving ? 'Saving…' : 'Send correction'}
            </button>
          </div>
        </div>
      ) : (
        <div className="lesson-actions">
          <button onClick={() => setRejecting(true)} disabled={saving}>
            That's not it
          </button>
          <button
            className="primary"
            onClick={() => decide(() => onAccept(lesson.id))}
            disabled={saving}
          >
            {saving ? 'Saving…' : lesson.scope === 'none' ? 'Agreed' : 'Remember this'}
          </button>
        </div>
      )}
    </div>
  );
}
