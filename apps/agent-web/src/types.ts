import type { ReviewField } from './api';

export type Fund = {
  id: string;
  name: string;
};

/**
 * A file the analyst has picked, held in the browser. Nothing here has been sent
 * to the backend yet — that happens on send, in one request for all files.
 */
export type StagedFile = {
  id: string;
  file: File;
  status: 'ready' | 'rejected';
  /** Present only when status is 'rejected'. */
  rejectionReason?: string;
};

/**
 * One correction, captured when the analyst finishes with a field rather than
 * on every keystroke — otherwise "462090073000" is eleven events.
 *
 * The context is snapshotted rather than looked up later. A re-extraction
 * replaces the fields this came from, and an event that silently starts
 * describing a different reading is worse than one that is merely stale.
 */
export type EditEvent = {
  id: string;
  fieldKey: string;
  /** What the model proposed. */
  from: string;
  /** What the analyst set it to. */
  to: string;
  at: string;
  context: {
    sourceText: string;
    sourcePage: number | null;
    confidence: string;
    reasoning: string;
  };
};

export type ChatMessage = {
  id: string;
  author: 'agent' | 'analyst';
  text: string;
  attachments?: { name: string; size: number }[];
  /** Failures are shown in the log rather than swallowed into an alert. */
  variant?: 'error';
  /** Marks a reply that came from a recording, so a demo cannot mislead. */
  fixture?: boolean;
};

export type Analysis = {
  id: string;
  fundId: string;
  fundName: string;
  createdAt: string;
  /**
   * Approved analyses are read-only: they have been written to customer-system
   * and that database is the source of truth. Nothing sets this yet.
   */
  status: 'draft' | 'approved';
  messages: ChatMessage[];
  /** Empty until an extraction comes back. Replaced wholesale by the latest one. */
  fields: ReviewField[];
  /**
   * Analyst corrections, keyed by field, held as the raw text they typed.
   *
   * Text rather than a parsed value because a field is not necessarily money —
   * the customer's schema decides that, and a control that assumes a number
   * breaks the day one of these is a date or a flag. Coercion happens against
   * the field definition on the way out, and the customer's API is the
   * authority on whether it was right.
   *
   * Kept apart from `fields` rather than merged into them: what the model said
   * and what the analyst said are both needed to work out why an edit happened,
   * and merging destroys the first.
   */
  edits: Record<string, string>;
  /**
   * What the analyst actually changed, in the order they changed it. Distinct
   * from `edits`: that is the current state of the table, this is the record of
   * what happened, and step 10 diagnoses the second not the first.
   */
  editEvents: EditEvent[];
  /** The reporting period the values belong to. The analyst supplies it. */
  fiscalYearEnd: string;
  /**
   * Per-field rejections from the customer's last write attempt, keyed by
   * field. Cleared when the analyst changes anything, because a complaint about
   * a value they have since edited is worse than no complaint.
   */
  writeProblems: Record<string, string>;
};
