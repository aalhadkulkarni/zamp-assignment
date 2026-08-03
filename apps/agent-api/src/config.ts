import { resolve } from 'node:path';

/**
 * Where uploaded documents land. On Render this is ephemeral — a redeploy or a
 * restart wipes it. That is acceptable for now because documents are input to an
 * extraction that runs right after upload, not a record we owe anyone. When
 * resuming an old analysis has to survive a restart, this becomes object storage
 * and only this module changes.
 */
export function dataDir(): string {
  return resolve(process.env.DATA_DIR ?? '.data');
}

/**
 * The browser enforces these too, but that is for feedback, not for safety. A
 * request can arrive from anywhere, so the server treats its own copy as the
 * authority and re-checks everything.
 */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.txt', '.md'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
export const MAX_PROMPT_LENGTH = 4000;
