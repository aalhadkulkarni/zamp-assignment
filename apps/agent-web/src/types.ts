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

export type ChatMessage = {
  id: string;
  author: 'agent' | 'analyst';
  text: string;
  attachments?: { name: string; size: number }[];
  /** Failures are shown in the log rather than swallowed or put in an alert. */
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
  /** The reporting period the values belong to. The analyst supplies it. */
  fiscalYearEnd: string;
  /**
   * Per-field rejections from the customer's last write attempt, keyed by
   * field. Cleared when the analyst changes anything, because a complaint about
   * a value they have since edited is worse than no complaint.
   */
  writeProblems: Record<string, string>;
};
