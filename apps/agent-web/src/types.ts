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


