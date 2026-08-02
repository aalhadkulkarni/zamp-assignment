import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';
import { MAX_FILE_BYTES } from './files';
import { FUNDS } from './funds';

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
  it('confirms every document received, with its size', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), [
      pdf('page-4.pdf', 2048),
      pdf('page-5.pdf', 4096),
    ]);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const log = screen.getByRole('log');
    expect(
      within(log).getByText(/Received 2 documents: page-4\.pdf \(2 KB\), page-5\.pdf \(4 KB\)/),
    ).toBeInTheDocument();
  });

  it('sends the typed context along with the documents', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.type(screen.getByLabelText('Additional context'), 'use the table on page 4');
    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('use the table on page 4')).toBeInTheDocument();
  });

  it('clears the composer so the next message starts clean', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.type(screen.getByLabelText('Additional context'), 'in thousands');
    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByLabelText('Additional context')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
