import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_PROMPT_LENGTH,
  dataDir,
} from './config.js';

export type IncomingDocument = {
  filename: string;
  bytes: Buffer;
};

export type StoredDocument = {
  id: string;
  /** As the analyst named it. What we show them and what the model is told. */
  filename: string;
  /** Sanitised. Only ever used to build a path on disk. */
  storedAs: string;
  size: number;
};

export type Rejection = {
  filename: string;
  reason: string;
};

/**
 * Client-supplied ids end up in filesystem paths, so anything that is not a
 * plain uuid is refused outright rather than escaped. Nothing legitimate is
 * shaped any other way.
 */
export function isValidAnalysisId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * The filename is only ever a label — the bytes are written under a generated
 * id. Stripping the directory part means a name like ../../etc/passwd cannot
 * point the write anywhere, whatever else goes wrong downstream.
 */
export function safeFilename(filename: string): string {
  return basename(filename).replace(/[^\w.\- ]/g, '_').slice(0, 200);
}

export function validateDocument(doc: IncomingDocument): Rejection | null {
  const extension = extname(doc.filename).toLowerCase();

  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return {
      filename: doc.filename,
      reason: `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`,
    };
  }
  if (doc.bytes.length === 0) {
    return { filename: doc.filename, reason: 'File is empty' };
  }
  if (doc.bytes.length > MAX_FILE_BYTES) {
    return { filename: doc.filename, reason: 'File exceeds the size limit' };
  }
  return null;
}

export function validatePrompt(prompt: string): string | null {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return `Prompt exceeds ${MAX_PROMPT_LENGTH} characters`;
  }
  return null;
}

export function uploadDir(tenantId: string, analysisId: string): string {
  return join(dataDir(), tenantId, analysisId);
}

/**
 * Writes every document, then a manifest describing the upload. The manifest is
 * written last so a directory containing one is known to be complete — a crash
 * midway leaves loose files and no manifest, which is a state we can recognise.
 */
export async function storeUpload(
  tenantId: string,
  analysisId: string,
  documents: IncomingDocument[],
  prompt: string,
): Promise<{ uploadId: string; stored: StoredDocument[] }> {
  const uploadId = crypto.randomUUID();
  const dir = uploadDir(tenantId, analysisId);
  await mkdir(dir, { recursive: true });

  const stored: StoredDocument[] = [];
  for (const doc of documents) {
    const id = crypto.randomUUID();
    // Sanitising is about where the bytes land, not about what the analyst is
    // allowed to call their file. Showing them a name they did not choose makes
    // it look like we mangled their document.
    const storedAs = safeFilename(doc.filename);
    await writeFile(join(dir, `${id}-${storedAs}`), doc.bytes);
    stored.push({ id, filename: doc.filename, storedAs, size: doc.bytes.length });
  }

  await writeFile(
    join(dir, `upload-${uploadId}.json`),
    JSON.stringify({ uploadId, tenantId, analysisId, prompt, documents: stored, receivedAt: new Date().toISOString() }, null, 2),
  );

  return { uploadId, stored };
}
