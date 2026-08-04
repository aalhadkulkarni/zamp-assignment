const AGENT_API = import.meta.env.VITE_AGENT_API_URL ?? 'http://localhost:3001';

export type Fund = {
  id: string;
  name: string;
};

/**
 * Via agent-api rather than straight to the customer's system: that integration
 * carries credentials, and those never belong in the browser.
 */
export async function listFunds(): Promise<Fund[]> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_API}/funds`);
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.message ?? 'Could not load funds.', response.status);
  }

  return response.json();
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_API}${path}`, init);
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.message ?? `Request failed (${response.status}).`, response.status);
  }
  return response.json();
}

export type AnalysisSummary = {
  id: string;
  fundId: string;
  fundName: string;
  status: 'draft' | 'approved';
  createdAt: string;
};

export type StoredMessage = {
  id: string;
  author: 'agent' | 'analyst';
  text: string;
  variant?: 'error';
  fixture?: boolean;
  attachments?: { name: string; size: number }[];
  /** Set when the message records a batch of corrections the analyst made. */
  corrections?: { fieldKey: string; from: string; to: string }[];
};

/** The whole analysis as the server holds it. The browser renders this rather
 *  than accumulating its own copy, so a refresh costs nothing. */
export type AgentWork = { state: 'idle' | 'running' | 'failed'; error: string | null };

export type StoredAnalysis = AnalysisSummary & {
  /**
   * Whether the agent is reading a document right now. Separate from status: an
   * analysis is a draft either way.
   */
  extraction: AgentWork;
  /** Whether the agent is working out why a batch of corrections happened. */
  diagnosis: AgentWork;
  fiscalYearEnd: string;
  messages: StoredMessage[];
  fields: ReviewField[];
  lessons: Lesson[];
};

export function createAnalysis(fundId: string): Promise<AnalysisSummary> {
  return json<AnalysisSummary>('/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fundId }),
  });
}

export function listAnalyses(): Promise<AnalysisSummary[]> {
  return json<AnalysisSummary[]>('/analyses');
}

export function getAnalysis(analysisId: string): Promise<StoredAnalysis> {
  return json<StoredAnalysis>(`/analyses/${analysisId}`);
}

export function decideLesson(
  analysisId: string,
  lessonId: string,
  decision: 'accepted' | 'rejected',
  comment?: string,
): Promise<Lesson> {
  return json<Lesson>(`/analyses/${analysisId}/lessons/${lessonId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, comment }),
  });
}

export type WriteProblem = { field: string; reason: string };

/**
 * Carries the customer's own rejection. Their validation messages reach the
 * analyst unaltered — rewording them would put us between the analyst and the
 * system that actually refused the write.
 */
export class WriteRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly problems: WriteProblem[];

  constructor(message: string, status: number, code: string, problems: WriteProblem[]) {
    super(message);
    this.name = 'WriteRejected';
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

export async function writeReport(
  analysisId: string,
  fundId: string,
  fiscalYearEnd: string,
  values: Record<string, string>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_API}/analyses/${analysisId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fundId, fiscalYearEnd, values }),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new WriteRejected(
      body?.message ?? `The write failed (${response.status}).`,
      response.status,
      body?.error ?? 'WriteRejected',
      body?.problems ?? [],
    );
  }
}

export type EditEventPayload = {
  id: string;
  fieldKey: string;
  from: string;
  to: string;
  at: string;
  context: {
    sourceText: string;
    sourcePage: number | null;
    confidence: string;
    reasoning: string;
  };
};

export type LessonType = 'typo' | 'wrong_source' | 'units' | 'concept_confusion' | 'synonym';
/** none: nothing to remember. fund: every future document from this fund.
 *  global: every document from every fund. */
export type LessonScope = 'none' | 'fund' | 'global';

export type Lesson = {
  id: string;
  type: LessonType;
  scope: LessonScope;
  fieldKey: string;
  /** Other corrected fields the agent thinks changed for the same reason. */
  sharedWith: string[];
  explanation: string;
  rule: string;
  confidence: 'high' | 'medium' | 'low';
  /** The corrections this lesson explains, with the values that changed. */
  corrections: { fieldKey: string; from: string; to: string }[];
  decision?: 'accepted' | 'rejected';
  comment?: string;
};

export type Diagnosis = {
  summary: string;
  lessons: Lesson[];
};

/**
 * What a 202 gives back: the corrections are recorded and are being looked at.
 *
 * Nothing about what caused them, because working that out is a model call. The
 * proposed lessons arrive the same way an extraction does — the server says the
 * analysis changed, and we re-read it.
 */
export type EditsResult = {
  batchId: string | null;
  received: number;
};

/**
 * The whole batch in one call. Corrections made together are usually one
 * mistake seen from several angles, and sending them one at a time would hide
 * the pattern that explains them.
 */
export async function submitEdits(
  analysisId: string,
  fundId: string,
  edits: EditEventPayload[],
): Promise<EditsResult> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_API}/analyses/${analysisId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fundId, edits }),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.message ?? 'Could not record your corrections.', response.status);
  }

  return response.json();
}

export type UploadedDocument = {
  id: string;
  filename: string;
  size: number;
};

/** One row of the review table: the model's answer plus the units arithmetic. */
export type ReviewField = {
  key: string;
  /** Whole USD — valueAsPrinted x unitsMultiplier, computed on the server. */
  value: number | null;
  valueAsPrinted: number | null;
  unitsMultiplier: number;
  confidence: 'high' | 'medium' | 'low';
  sourcePage: number | null;
  sourceText: string;
  reasoning: string;
  /** Set when a lesson the analyst ratified changed this row after extraction. */
  lessonNote?: string;
};

export type ModelReply = {
  model: string;
  /** Prose for the chat panel, written by the same pass that produced the fields. */
  summary: string;
  fields: ReviewField[];
  usage: { inputTokens: number; outputTokens: number };
  /** True when the server answered from a recording instead of calling the model. */
  fixture: boolean;
};

export type ModelFailure = { code: string; message: string };

/**
 * What a 202 gives back: the documents are stored and the reading has started.
 *
 * Nothing about what was found, because nothing has been found yet. That answer
 * arrives when the server says the analysis changed and we re-read it.
 */
export type UploadResult = {
  uploadId: string;
  analysisId: string;
  prompt: string;
  documents: UploadedDocument[];
};

/**
 * Carries the message the API gave us. The analyst needs to see why a request
 * was refused, so nothing here collapses a failure into a generic message.
 */
export class ApiError extends Error {
  // Written out rather than declared as constructor parameters, because
  // erasableSyntaxOnly rules out the shorthand.
  readonly status: number;
  readonly rejected?: { filename: string; reason: string }[];

  constructor(
    message: string,
    status: number,
    rejected?: { filename: string; reason: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.rejected = rejected;
  }
}

export async function uploadDocuments(
  analysisId: string,
  fundId: string,
  files: File[],
  prompt: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('fundId', fundId);
  for (const file of files) form.append('documents', file, file.name);

  let response: Response;
  try {
    response = await fetch(`${AGENT_API}/analyses/${analysisId}/documents`, {
      method: 'POST',
      body: form,
    });
  } catch {
    // fetch only rejects when the request never completed — offline, DNS, CORS.
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      body?.message ?? `Upload failed (${response.status}).`,
      response.status,
      body?.rejected,
    );
  }

  return response.json();
}

/**
 * Calls back whenever the server says this analysis changed.
 *
 * The event carries no detail — only that something moved — so the caller
 * re-reads the analysis. One description of an analysis that both sides agree
 * on beats two that can drift apart, and it means adding a field to the server
 * needs no change here.
 *
 * EventSource reconnects on its own, which is most of why this is SSE rather
 * than a socket. If the connection drops mid-extraction the browser re-opens it
 * and the next change still lands.
 */
export function watchAnalysis(analysisId: string, onChange: () => void): () => void {
  const source = new EventSource(`${AGENT_API}/analyses/${analysisId}/events`);
  source.addEventListener('changed', () => onChange());

  // Also on connect — and `open` fires again on every reconnect, which is the
  // point. An event published while the stream was down is gone: nothing
  // replays it, so a client that only listened for `changed` would wait for a
  // notification that had already been and passed. That is a spinner turning
  // forever over work that finished a minute ago, and it happened.
  //
  // Re-reading when there was nothing to re-read costs one request and is
  // idempotent, which is a good trade against never finding out.
  source.addEventListener('open', () => onChange());

  // Deliberately no error handler that closes the stream: the default behaviour
  // is to retry, and closing on the first blip is how a page ends up silently
  // never updating again.
  return () => source.close();
}
