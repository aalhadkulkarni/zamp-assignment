import type { StagedFile } from './types';

/**
 * Checked by extension rather than MIME type. Browsers disagree about the type
 * of a .md file — Chrome on macOS reports an empty string, others report
 * text/markdown or text/x-markdown — so the extension is the reliable signal.
 */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.txt', '.md'];

/**
 * Documents are pre-cut to the pages that matter, so anything this large is
 * almost certainly a full report that will not fit in a model request anyway.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Validation is synchronous, so a staged file is either ready or rejected.
 * There is no in-between state to report until the files are actually sent.
 */
export function stageFile(file: File): StagedFile {
  const base = { id: crypto.randomUUID(), file };

  if (!ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
    return {
      ...base,
      status: 'rejected',
      rejectionReason: `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`,
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ...base,
      status: 'rejected',
      rejectionReason: `Too large (${formatBytes(file.size)}). Limit is ${formatBytes(MAX_FILE_BYTES)}`,
    };
  }

  if (file.size === 0) {
    return { ...base, status: 'rejected', rejectionReason: 'File is empty' };
  }

  return { ...base, status: 'ready' };
}

/** Picking the same file twice is a slip, not an instruction. */
export function isDuplicate(staged: StagedFile[], file: File): boolean {
  return staged.some((s) => s.file.name === file.name && s.file.size === file.size);
}
