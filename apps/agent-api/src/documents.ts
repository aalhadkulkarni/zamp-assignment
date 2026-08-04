import { extname } from 'node:path';
import { getPool } from './db.js';
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES, MAX_PROMPT_LENGTH } from './config.js';

export type IncomingDocument = {
  filename: string;
  bytes: Buffer;
};

export type StoredDocument = {
  id: string;
  /** As the analyst named it. There is no second name any more — see below. */
  filename: string;
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


/**
 * One correction the analyst made, with the provenance of the value they
 * corrected. The whole batch is what step 10 diagnoses.
 */
export type EditEvent = {
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


/**
 * The pages, stored as bytes in the row rather than as a path to a file.
 *
 * On disk they did not survive a deploy — Render's filesystem is wiped on every
 * restart — and the diagnosis reads them back to see what else was on the page.
 * Losing them there costs three of the five lesson types, silently, in
 * production only. Bytes in the database is the smallest thing that fixes that.
 *
 * At our sizes this is comfortable: a cut of ten pages is around 1.2MB and an
 * upload is capped at ten files, so worst case is roughly 12MB against a free
 * tier of half a gigabyte. It stops being the right answer somewhere around
 * whole ACFRs at scale, and at that point the bytes move to object storage and
 * the row keeps a key — which is a change to this function and nothing else.
 */
export async function storeUpload(
  analysisId: string,
  documents: IncomingDocument[],
  _prompt: string,
): Promise<{ uploadId: string; stored: StoredDocument[] }> {
  const pool = getPool();
  const uploadId = crypto.randomUUID();
  const stored: StoredDocument[] = [];

  for (const doc of documents) {
    const { rows } = await pool.query(
      `INSERT INTO document (id, analysis_id, upload_id, filename, extension, size_bytes, bytes)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        analysisId,
        uploadId,
        // The analyst's name, unchanged. Sanitising it was about stopping a
        // filename steering a write out of its directory. The bytes go in a
        // column now, so there is no path to steer and nothing to protect
        // against — keeping the mangling would only mean showing people a name
        // they did not choose.
        doc.filename,
        extname(doc.filename).toLowerCase(),
        doc.bytes.length,
        doc.bytes,
      ],
    );
    stored.push({ id: rows[0].id, filename: doc.filename, size: doc.bytes.length });
  }

  return { uploadId, stored };
}

/**
 * The documents from the most recent upload, for the diagnosis to look at.
 *
 * Returns nothing when there are none, which is no longer the routine case it
 * was on disk — but a diagnosis without the page is still better than a failure.
 */
export async function readUploadedDocuments(
  analysisId: string,
): Promise<{ filename: string; extension: string; bytes: Buffer }[]> {
  const { rows } = await getPool().query(
    `SELECT filename, extension, bytes FROM document
      WHERE analysis_id = $1
        AND upload_id = (
          SELECT upload_id FROM document WHERE analysis_id = $1
           ORDER BY created_at DESC LIMIT 1
        )
      ORDER BY created_at`,
    [analysisId],
  );
  return rows.map((row) => ({
    filename: row.filename,
    extension: row.extension,
    bytes: row.bytes,
  }));
}
