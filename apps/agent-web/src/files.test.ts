import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, formatBytes, isDuplicate, stageFile } from './files';

function fileOf(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('stageFile', () => {
  it('accepts the document types we can actually read', () => {
    for (const name of ['report.pdf', 'notes.txt', 'summary.md']) {
      expect(stageFile(fileOf(name, 1024)).status).toBe('ready');
    }
  });

  it('accepts extensions regardless of case', () => {
    expect(stageFile(fileOf('REPORT.PDF', 1024)).status).toBe('ready');
  });

  it('rejects types we cannot read, naming what is accepted', () => {
    const staged = stageFile(fileOf('report.docx', 1024));
    expect(staged.status).toBe('rejected');
    expect(staged.rejectionReason).toContain('.pdf');
  });

  it('rejects a file with no extension', () => {
    expect(stageFile(fileOf('report', 1024)).status).toBe('rejected');
  });

  it('rejects files over the size limit and says how big they were', () => {
    const staged = stageFile(fileOf('huge.pdf', MAX_FILE_BYTES + 1));
    expect(staged.status).toBe('rejected');
    expect(staged.rejectionReason).toContain('Too large');
  });

  it('rejects empty files', () => {
    const staged = stageFile(fileOf('empty.pdf', 0));
    expect(staged.status).toBe('rejected');
    expect(staged.rejectionReason).toBe('File is empty');
  });
});

describe('isDuplicate', () => {
  it('matches on name and size together', () => {
    const staged = [stageFile(fileOf('report.pdf', 1024))];

    expect(isDuplicate(staged, fileOf('report.pdf', 1024))).toBe(true);
    // Same name, different content — a revised document, not a double-pick.
    expect(isDuplicate(staged, fileOf('report.pdf', 2048))).toBe(false);
    expect(isDuplicate(staged, fileOf('other.pdf', 1024))).toBe(false);
  });
});

describe('formatBytes', () => {
  it('scales the unit to the size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
