const AGENT_API = import.meta.env.VITE_AGENT_API_URL ?? 'http://localhost:3001';

export type Fund = {
  id: string;
  name: string;
  issuer: string;
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

export type UploadedDocument = {
  id: string;
  /** As the analyst named it. */
  filename: string;
  /** Sanitised name on the server's disk. Not shown to the analyst. */
  storedAs: string;
  size: number;
};

export type ModelReply = {
  model: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when the server answered from a recording instead of calling the model. */
  fixture: boolean;
};

export type ModelFailure = { code: string; message: string };

export type UploadResult = {
  uploadId: string;
  analysisId: string;
  prompt: string;
  documents: UploadedDocument[];
  /** Null when the model could not be reached — the documents are stored either way. */
  agent: ModelReply | null;
  agentError: ModelFailure | null;
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
  files: File[],
  prompt: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.set('prompt', prompt);
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
