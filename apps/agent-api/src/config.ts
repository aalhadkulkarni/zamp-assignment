
/**
 * The browser enforces these too, but that is for feedback, not for safety. A
 * request can arrive from anywhere, so the server treats its own copy as the
 * authority and re-checks everything.
 */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.txt', '.md'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
export const MAX_PROMPT_LENGTH = 4000;
