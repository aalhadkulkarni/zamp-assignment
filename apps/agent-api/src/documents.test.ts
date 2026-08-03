import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from './config.js';
import { isValidAnalysisId, safeFilename, validateDocument } from './documents.js';

const doc = (filename: string, size = 64) => ({
  filename,
  bytes: Buffer.alloc(size),
});

describe('isValidAnalysisId', () => {
  it('accepts a uuid', () => {
    expect(isValidAnalysisId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('refuses anything that could steer a filesystem path', () => {
    for (const id of ['..', '../../etc', 'a/b', '', 'not-a-uuid']) {
      expect(isValidAnalysisId(id)).toBe(false);
    }
  });
});

describe('safeFilename', () => {
  it('drops the directory part so a name cannot escape the upload folder', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  it('replaces characters that have meaning to a shell or a path', () => {
    expect(safeFilename('re;port$(x).pdf')).toBe('re_port__x_.pdf');
  });

  it('keeps ordinary names intact', () => {
    expect(safeFilename('calstrs acfr-2023.pdf')).toBe('calstrs acfr-2023.pdf');
  });

  it('caps the length', () => {
    expect(safeFilename(`${'a'.repeat(500)}.pdf`)).toHaveLength(200);
  });
});

describe('validateDocument', () => {
  it('accepts the types we can read', () => {
    for (const name of ['a.pdf', 'b.txt', 'c.md', 'D.PDF']) {
      expect(validateDocument(doc(name))).toBeNull();
    }
  });

  it('rejects other types', () => {
    expect(validateDocument(doc('a.docx'))?.reason).toMatch(/Unsupported file type/);
    expect(validateDocument(doc('a'))?.reason).toMatch(/Unsupported file type/);
  });

  it('rejects empty and oversized files', () => {
    expect(validateDocument(doc('a.pdf', 0))?.reason).toBe('File is empty');
    expect(validateDocument(doc('a.pdf', MAX_FILE_BYTES + 1))?.reason).toMatch(/size limit/);
  });
});
