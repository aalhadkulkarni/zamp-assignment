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
};
