import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ApiError, uploadDocuments, type UploadResult } from './api';
import { MAX_FILE_BYTES } from './files';
import { FUNDS } from './funds';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  uploadDocuments: vi.fn(),
}));

const mockUpload = vi.mocked(uploadDocuments);

const AGENT_TEXT = 'Received your two documents. Extraction is next.';

/** Echoes back what the real endpoint returns for an accepted upload. */
function accepts(overrides: Partial<UploadResult> = {}) {
  mockUpload.mockImplementation(async (analysisId, files, prompt) => ({
    uploadId: 'upload-1',
    analysisId,
    prompt,
    documents: files.map((f, i) => ({
      id: `doc-${i}`,
      filename: f.name,
      storedAs: f.name,
      size: f.size,
    })),
    agent: {
      model: 'claude-opus-5',
      text: AGENT_TEXT,
      usage: { inputTokens: 120, outputTokens: 14 },
    },
    agentError: null,
    ...overrides,
  }));
}

beforeEach(() => {
  mockUpload.mockReset();
  accepts();
});

function pdf(name: string, bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** Landing → new analysis → workspace. Every test needs this much. */
async function startAnalysis(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole('button', { name: 'New analysis' }));
  await user.selectOptions(screen.getByLabelText('Fund'), FUNDS[0].id);
  await user.click(screen.getByRole('button', { name: 'Start analysis' }));
}

describe('starting an analysis', () => {
  it('shows an empty state before any analysis exists', () => {
    render(<App />);
    expect(screen.getByText('No analyses yet.')).toBeInTheDocument();
  });

  it('cannot start without picking a fund', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'New analysis' }));
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Fund'), FUNDS[0].id);
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeEnabled();
  });

  it('opens the workspace on the chosen fund and asks for documents', async () => {
    await startAnalysis(userEvent.setup());

    expect(screen.getByRole('heading', { name: FUNDS[0].name })).toBeInTheDocument();
    expect(screen.getByText(/Upload the documents you want analysed/)).toBeInTheDocument();
  });

  it('lists the analysis on the landing page once created', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.click(screen.getByRole('button', { name: '← Analyses' }));
    expect(screen.getByText(FUNDS[0].name)).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
  });
});

describe('staging documents', () => {
  it('cannot send until a usable document is staged', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Text alone is not enough — the first message has to carry documents.
    await user.type(screen.getByLabelText('Additional context'), 'figures are in thousands');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr-2023.pdf'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('keeps an oversized file visible with its reason, and still refuses to send', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('full-acfr.pdf', MAX_FILE_BYTES + 1));

    expect(screen.getByText('full-acfr.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Too large/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /**
   * The input's accept filter keeps unsupported types out of the file picker, so
   * a bad type can only arrive by drag-and-drop. That path has to reject it too.
   */
  it('rejects an unsupported type dropped onto the composer', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    fireEvent.drop(screen.getByText(/drag them here/), {
      dataTransfer: { files: [new File([new Uint8Array(1024)], 'report.docx')] },
    });

    expect(screen.getByText('report.docx')).toBeInTheDocument();
    expect(screen.getByText(/Unsupported file type/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('ignores the same file picked twice', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    const input = screen.getByLabelText(/Choose documents/);
    await user.upload(input, pdf('acfr.pdf'));
    await user.upload(input, pdf('acfr.pdf'));

    expect(screen.getAllByText('acfr.pdf')).toHaveLength(1);
  });

  it('takes several documents at once and lets one be removed', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), [
      pdf('page-4.pdf'),
      pdf('page-5.pdf', 4096),
    ]);
    expect(screen.getByText('page-4.pdf')).toBeInTheDocument();
    expect(screen.getByText('page-5.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove page-4.pdf' }));
    expect(screen.queryByText('page-4.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('page-5.pdf')).toBeInTheDocument();
  });
});

describe('sending', () => {
  it("shows the agent's own reply rather than a canned confirmation", async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), [
      pdf('page-4.pdf', 2048),
      pdf('page-5.pdf', 4096),
    ]);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const log = screen.getByRole('log');
    expect(await within(log).findByText(AGENT_TEXT)).toBeInTheDocument();
  });

  /**
   * The documents reached the server; only the model call failed. Saying the
   * upload failed would send the analyst back to re-pick files we already have.
   */
  it('reports a stored upload whose model call failed, without losing the documents', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);
    accepts({
      agent: null,
      agentError: { code: 'RateLimited', message: 'Anthropic is rate limiting us.' },
    });

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/stored, but the assistant could not be reached/)).
      toBeInTheDocument();
    expect(screen.getByText(/Anthropic is rate limiting us/)).toBeInTheDocument();
    // Composer still clears — the upload itself succeeded.
    expect(screen.getByLabelText('Additional context')).toHaveValue('');
  });

  it('posts the documents and the typed context to the analysis being viewed', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.type(screen.getByLabelText('Additional context'), 'use the table on page 4');
    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockUpload).toHaveBeenCalledOnce());
    const [analysisId, files, prompt] = mockUpload.mock.calls[0];
    expect(analysisId).toMatch(/^[0-9a-f-]{36}$/);
    expect(files.map((f) => f.name)).toEqual(['acfr.pdf']);
    expect(prompt).toBe('use the table on page 4');

    expect(await screen.findByText('use the table on page 4')).toBeInTheDocument();
  });

  it('never sends a file the browser rejected', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), [
      pdf('good.pdf'),
      pdf('huge.pdf', MAX_FILE_BYTES + 1),
    ]);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockUpload).toHaveBeenCalledOnce());
    expect(mockUpload.mock.calls[0][1].map((f) => f.name)).toEqual(['good.pdf']);
  });

  /**
   * Regression: addFiles used to read the input's FileList inside the state
   * updater, after the handler had already reset the input to re-enable
   * re-picking. A FileList is a live view, so it was empty by then and the
   * second document never staged.
   */
  it('accepts more documents after a message has been sent', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    const input = screen.getByLabelText(/Choose documents/);
    await user.upload(input, pdf('first.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await user.upload(input, pdf('second.pdf'));

    expect(screen.getByText('second.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('says why sending is blocked when only text has been entered', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    expect(screen.queryByText(/Attach a document to send/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Additional context'), 'also consider this');
    expect(screen.getByText(/Attach a document to send/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    expect(screen.queryByText(/Attach a document to send/)).not.toBeInTheDocument();
  });

  it('clears the composer so the next message starts clean', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.type(screen.getByLabelText('Additional context'), 'in thousands');
    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByLabelText('Additional context')).toHaveValue(''));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('when the upload is refused', () => {
  async function sendAgainst(rejection: ApiError) {
    const user = userEvent.setup();
    await startAnalysis(user);
    mockUpload.mockRejectedValue(rejection);

    await user.type(screen.getByLabelText('Additional context'), 'in thousands');
    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    return user;
  }

  it("shows the server's reason rather than a generic failure", async () => {
    await sendAgainst(new ApiError('At most 10 documents per upload.', 413));

    expect(await screen.findByText(/At most 10 documents per upload/)).toBeInTheDocument();
  });

  it('names each document the server refused, and why', async () => {
    await sendAgainst(
      new ApiError('No documents were stored.', 400, [
        { filename: 'bad.docx', reason: 'Unsupported file type' },
      ]),
    );

    expect(await screen.findByText(/bad\.docx: Unsupported file type/)).toBeInTheDocument();
  });

  it('keeps the documents and the text so the analyst can retry', async () => {
    await sendAgainst(new ApiError('Could not reach the server.', 0));

    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    expect(screen.getByText('acfr.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Additional context')).toHaveValue('in thousands');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('does not put the analyst message in the log for a message that never landed', async () => {
    await sendAgainst(new ApiError('Could not reach the server.', 0));

    const log = screen.getByRole('log');
    await screen.findByText(/Could not reach the server/);
    expect(within(log).queryByText('in thousands')).not.toBeInTheDocument();
  });

  it('lets a retry succeed after the problem is fixed', async () => {
    const user = await sendAgainst(new ApiError('Could not reach the server.', 0));
    await screen.findByText(/Could not reach the server/);

    accepts();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(AGENT_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('Additional context')).toHaveValue('');
  });
});
