import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as api from './api';
import { ApiError, WriteRejected } from './api';
import { MAX_FILE_BYTES } from './files';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  listFunds: vi.fn(),
  createAnalysis: vi.fn(),
  listAnalyses: vi.fn(),
  getAnalysis: vi.fn(),
  uploadDocuments: vi.fn(),
  writeReport: vi.fn(),
  submitEdits: vi.fn(),
  decideLesson: vi.fn(),
}));

const mockListFunds = vi.mocked(api.listFunds);
const mockUpload = vi.mocked(api.uploadDocuments);
const mockWrite = vi.mocked(api.writeReport);
const mockSubmitEdits = vi.mocked(api.submitEdits);

const FUNDS = [
  { id: 'calpers', name: 'CalPERS — California Public Employees’ Retirement System' },
  { id: 'calstrs', name: 'CalSTRS — California State Teachers’ Retirement System' },
];
const FUND_LABEL = FUNDS[0].name;

const AGENT_TEXT = 'I found four of the five values. Total receivables was not broken out.';

/** Shaped like a real extraction: real figures, thousands, and one genuine blank. */
const FIELDS: api.ReviewField[] = [
  {
    key: 'total_investments',
    value: 462_090_073_000,
    valueAsPrinted: 462_090_073,
    unitsMultiplier: 1000,
    confidence: 'high',
    sourcePage: 1,
    sourceText: 'Total Investments $462,090,073',
    reasoning: 'Investments at Fair Value section, PERF A column.',
  },
  {
    key: 'total_receivables',
    value: null,
    valueAsPrinted: null,
    unitsMultiplier: 1000,
    confidence: 'low',
    sourcePage: null,
    sourceText: '',
    reasoning: 'No combined receivables line in the PERF A column.',
  },
];

/**
 * A small stand-in for agent-api that honours its contract: an analysis is
 * server-held, and the browser re-reads it after every change. Asserting
 * against a coherent fake keeps these tests about the UI while still catching
 * the case that matters — the client showing something the server never said.
 */
const server = {
  analyses: new Map<string, api.StoredAnalysis>(),

  reset() {
    server.analyses.clear();
    server.nextFields = FIELDS;
    server.restoreUpload();

    mockListFunds.mockResolvedValue(FUNDS);
    vi.mocked(api.listAnalyses).mockImplementation(async () => [...server.analyses.values()]);
    vi.mocked(api.getAnalysis).mockImplementation(async (id) => {
      const found = server.analyses.get(id);
      if (!found) throw new api.ApiError('No such analysis.', 404);
      return structuredClone(found);
    });
    vi.mocked(api.createAnalysis).mockImplementation(async (fundId) => {
      const analysis: api.StoredAnalysis = {
        id: crypto.randomUUID(),
        fundId,
        fundName: FUNDS.find((f) => f.id === fundId)!.name,
        status: 'draft',
        createdAt: new Date().toISOString(),
        fiscalYearEnd: '',
        messages: [{ id: 'm0', author: 'agent', text: 'Upload the documents you want analysed.' }],
        fields: [],
        lessons: [],
      };
      server.analyses.set(analysis.id, analysis);
      return analysis;
    });

    mockWrite.mockImplementation(async (analysisId, _fundId, fiscalYearEnd) => {
      const analysis = server.analyses.get(analysisId)!;
      analysis.status = 'approved';
      analysis.fiscalYearEnd = fiscalYearEnd;
      analysis.messages.push({
        id: crypto.randomUUID(),
        author: 'agent',
        text: `Written to the customer's system for the period ending ${fiscalYearEnd}. This analysis is now read-only.`,
      });
    });

    // No diagnosis by default; a test that wants one calls server.diagnoses().
    mockSubmitEdits.mockResolvedValue({
      batchId: 'batch-1',
      received: 1,
      diagnosis: null,
      error: null,
    });

    vi.mocked(api.decideLesson).mockImplementation(async (analysisId, lessonId, decision, comment) => {
      const analysis = server.analyses.get(analysisId)!;
      const lesson = analysis.lessons.find((l) => l.id === lessonId)!;
      Object.assign(lesson, { decision, comment });
      return lesson;
    });
  },

  restoreUpload() {
    mockUpload.mockImplementation(async (analysisId, _fundId, files, prompt) => {
      const analysis = server.analyses.get(analysisId)!;
      analysis.messages.push(
        {
          id: crypto.randomUUID(),
          author: 'analyst',
          text: prompt,
          attachments: files.map((f) => ({ name: f.name, size: f.size })),
        },
        { id: crypto.randomUUID(), author: 'agent', text: AGENT_TEXT },
      );
      analysis.fields = structuredClone(server.nextFields);
      return {
        uploadId: 'upload-1',
        analysisId,
        prompt,
        documents: files.map((f, i) => ({ id: `doc-${i}`, filename: f.name, size: f.size })),
        agent: {
          model: 'claude-opus-5',
          summary: AGENT_TEXT,
          fields: structuredClone(server.nextFields),
          usage: { inputTokens: 24180, outputTokens: 742 },
          fixture: false,
        },
        agentError: null,
      };
    });
  },

  /** What the next extraction finds. Defaults to FIELDS; reset between tests. */
  nextFields: FIELDS as api.ReviewField[],

  /** Lets a test hand back proposed lessons from the next submit. */
  diagnoses(diagnosis: api.Diagnosis) {
    mockSubmitEdits.mockImplementation(async (analysisId) => {
      const analysis = server.analyses.get(analysisId)!;
      analysis.lessons = structuredClone(diagnosis.lessons);
      analysis.messages.push({
        id: crypto.randomUUID(),
        author: 'agent',
        text: diagnosis.summary,
      });
      return { batchId: 'batch-1', received: 1, diagnosis, error: null };
    });
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  server.reset();
});

function pdf(name: string, bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** Landing → new analysis → workspace. Every test needs this much. */
async function startAnalysis(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole('button', { name: 'New analysis' }));
  await screen.findByRole('combobox');
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
    await screen.findByRole('combobox');
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Fund'), FUNDS[0].id);
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeEnabled();
  });

  it('lists the funds the customer system knows about', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'New analysis' }));

    expect(await screen.findByRole('option', { name: FUND_LABEL })).toBeInTheDocument();
    expect(mockListFunds).toHaveBeenCalledOnce();
  });

  /**
   * The fund list is the customer's data. If their system is down, saying so
   * beats an empty dropdown that reads as "you have no funds".
   */
  it('explains an unreachable customer system instead of showing an empty list', async () => {
    const user = userEvent.setup();
    mockListFunds.mockRejectedValue(new ApiError('Could not reach the server.', 0));
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'New analysis' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the server/);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeDisabled();
  });

  it('opens the workspace on the chosen fund and asks for documents', async () => {
    await startAnalysis(userEvent.setup());

    expect(screen.getByRole('heading', { name: FUND_LABEL })).toBeInTheDocument();
    expect(screen.getByText(/Upload the documents you want analysed/)).toBeInTheDocument();
  });

  it('lists the analysis on the landing page once created', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.click(screen.getByRole('button', { name: '← Analyses' }));
    expect(screen.getByText(FUND_LABEL)).toBeInTheDocument();
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
  it('marks a recorded reply so a demo cannot pass it off as a real call', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);
    // The server records that the reply was recorded, and the browser shows it.
    mockUpload.mockImplementation(async (analysisId, _fundId, files, prompt) => {
      const analysis = server.analyses.get(analysisId)!;
      analysis.messages.push({
        id: crypto.randomUUID(),
        author: 'agent',
        text: AGENT_TEXT,
        fixture: true,
      });
      analysis.fields = structuredClone(FIELDS);
      return {
        uploadId: 'u',
        analysisId,
        prompt,
        documents: files.map((f, i) => ({ id: `d${i}`, filename: f.name, size: f.size })),
        agent: {
          model: 'claude-opus-5',
          summary: AGENT_TEXT,
          fields: structuredClone(server.nextFields),
          usage: { inputTokens: 24180, outputTokens: 742 },
          fixture: true,
        },
        agentError: null,
      };
    });

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('recorded')).toBeInTheDocument();
  });

  it('renders the extracted values as a table beside the chat', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    expect(screen.getByText('No values yet.')).toBeInTheDocument();

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const review = await screen.findByRole('table');
    expect(within(review).getByText('total_investments')).toBeInTheDocument();
    // Whole dollars, not the printed thousands.
    expect(within(review).getByText('$462,090,073,000')).toBeInTheDocument();
    expect(within(review).getByText(/Total Investments \$462,090,073/)).toBeInTheDocument();
  });

  /**
   * The analyst checks the printed figure against the page, then checks we
   * scaled it correctly. Hiding the multiplier makes the second check
   * impossible without reopening the document.
   */
  it('shows the printed figure and the units behind a scaled value', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('table');

    // The analyst checks the figure against the page and the scaling against the
    // heading. Both have to be on screen, or the second check means reopening
    // the document.
    // The value is editable and in whole dollars, with the readable form beside
    // it so the analyst can check the figure without parsing digits.
    expect(screen.getByLabelText('total_investments value')).toHaveValue('462090073000');
    expect(screen.getByText('$462,090,073,000')).toBeInTheDocument();
  });

  it('marks a value it could not find rather than inventing one', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const review = await screen.findByRole('table');
    const row = within(review).getByText('total_receivables').closest('tr')!;
    expect(within(row).getByText('not found')).toBeInTheDocument();
    expect(within(row).getByText('low')).toBeInTheDocument();
  });

  describe('correcting a value', () => {
    async function extracted() {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');
      return user;
    }

    it('lets the analyst correct a value, showing the readable form as they go', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      await user.clear(value);
      await user.type(value, '462090074000');

      expect(await screen.findByText('$462,090,074,000')).toBeInTheDocument();
    });

    /**
     * A field is not necessarily money — the customer's schema decides that. The
     * control must not silently mangle something it does not understand.
     */
    it('accepts a value that is not a number and shows it back unchanged', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      await user.clear(value);
      await user.type(value, 'see note 7');

      expect(await screen.findAllByText('see note 7')).not.toHaveLength(0);
    });

    it('lets the analyst fill in a value the model could not find', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_receivables value');

      expect(value).toHaveValue('');
      await user.type(value, '38456658000');

      expect(await screen.findByText('$38,456,658,000')).toBeInTheDocument();
    });

    it('marks a corrected row and counts the corrections', async () => {
      const user = await extracted();
      expect(screen.getByText('Nothing changed yet.')).toBeInTheDocument();

      await user.type(screen.getByLabelText('total_investments value'), '0');

      expect(await screen.findByText('1 value corrected.')).toBeInTheDocument();
      expect(screen.getByText('edited')).toBeInTheDocument();
    });

    /**
     * A value typed back to what the model said is not a correction. Leaving the
     * row flagged would overstate what the analyst changed, and step 9 would
     * send a change that never happened off for a diagnosis.
     */
    it('stops treating a field as edited once it matches the model again', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      await user.type(value, '0');
      expect(await screen.findByText('1 value corrected.')).toBeInTheDocument();

      await user.clear(value);
      await user.type(value, '462090073000');

      expect(await screen.findByText('Nothing changed yet.')).toBeInTheDocument();
      expect(screen.queryByText('edited')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'revert' })).not.toBeInTheDocument();
    });

    it('treats clearing a value the model did not find as no change', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_receivables value');

      await user.type(value, '123');
      expect(await screen.findByText('1 value corrected.')).toBeInTheDocument();

      await user.clear(value);
      expect(await screen.findByText('Nothing changed yet.')).toBeInTheDocument();
    });

    it('puts a corrected value back the way the model had it', async () => {
      const user = await extracted();

      await user.type(screen.getByLabelText('total_investments value'), '0');
      await user.click(screen.getByRole('button', { name: 'revert' }));

      expect(screen.getByLabelText('total_investments value')).toHaveValue('462090073000');
      expect(screen.getByText('Nothing changed yet.')).toBeInTheDocument();
      // Reverting removes the correction rather than recording the original as
      // one — untouched and corrected-back are different facts.
      expect(screen.queryByText('edited')).not.toBeInTheDocument();
    });

    it('drops corrections when a new extraction replaces the values', async () => {
      const user = await extracted();
      await user.type(screen.getByLabelText('total_investments value'), '0');
      expect(await screen.findByText('1 value corrected.')).toBeInTheDocument();

      // A second upload is a fresh reading; an old fix no longer refers to
      // anything, and silently reapplying it would be worse than losing it.
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr-v2.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByText('Nothing changed yet.')).toBeInTheDocument();
    });

    it('offers a confirm action once there are values to write', async () => {
      await extracted();
      expect(screen.getByRole('button', { name: 'Confirm and write' })).toBeInTheDocument();
    });
  });

  describe('pending corrections', () => {
    async function extracted() {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');
      return user;
    }

    const draft = () => screen.queryByRole('region', { name: 'Pending corrections' });

    it('shows nothing until something is corrected', async () => {
      await extracted();
      expect(draft()).not.toBeInTheDocument();
    });

    /** Captured on blur, not per keystroke — a figure is not a dozen corrections. */
    it('lists a correction once the analyst leaves the field', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      await user.clear(value);
      await user.type(value, '999');
      expect(draft()).not.toBeInTheDocument();

      await user.tab();

      expect(await screen.findByText('1 correction — not yet submitted')).toBeInTheDocument();
      expect(within(draft()!).getByText('462090073000 → 999')).toBeInTheDocument();
    });

    /**
     * The reason this is a draft rendered from state rather than lines appended
     * to the log: changed, reverted, changed again is one correction, and only
     * where it ended up matters.
     */
    it('keeps one entry per field however many times it is changed', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      for (const attempt of ['100', '462090073000', '200']) {
        await user.clear(value);
        await user.type(value, attempt);
        await user.tab();
      }

      expect(await screen.findByText('1 correction — not yet submitted')).toBeInTheDocument();
      expect(within(draft()!).getAllByText(/→/)).toHaveLength(1);
      expect(within(draft()!).getByText('462090073000 → 200')).toBeInTheDocument();
    });

    it('drops the entry when a field goes back to what the model proposed', async () => {
      const user = await extracted();
      const value = screen.getByLabelText('total_investments value');

      await user.clear(value);
      await user.type(value, '999');
      await user.tab();
      await screen.findByText('1 correction — not yet submitted');

      await user.clear(value);
      await user.type(value, '462090073000');
      await user.tab();

      await waitFor(() => expect(draft()).not.toBeInTheDocument());
    });

    it('counts corrections across fields in one block', async () => {
      const user = await extracted();

      await user.type(screen.getByLabelText('total_receivables value'), '38456658000');
      await user.tab();
      await user.clear(screen.getByLabelText('total_investments value'));
      await user.type(screen.getByLabelText('total_investments value'), '462090073');
      await user.tab();

      expect(await screen.findByText('2 corrections — not yet submitted')).toBeInTheDocument();
    });
  });

  describe('the agent explaining a correction', () => {
    const UNITS_LESSON = {
      id: 'lesson-1',
      type: 'units' as const,
      scope: 'fund' as const,
      fieldKeys: ['total_investments'],
      explanation: 'I applied the thousands heading, but the figure you kept is the printed one.',
      rule: 'For this fund, check whether the investments section restates its units.',
      unitsMultiplier: 1,
      documentLabel: '',
      confidence: 'medium' as const,
    };

    async function corrected(diagnosis: unknown = { summary: 'Here is what I think went wrong.', lessons: [UNITS_LESSON] }) {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');
      await user.type(screen.getByLabelText('Period ending'), '2025-06-30');
      await user.clear(screen.getByLabelText('total_investments value'));
      await user.type(screen.getByLabelText('total_investments value'), '462090073');
      await user.tab();

      server.diagnoses(diagnosis as api.Diagnosis);
      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));
      return user;
    }

    /**
     * A ratified units lesson moves a value by a factor of a thousand without
     * asking. The row has to say so, or the analyst has no way to tell a rule
     * they agreed to from the model getting quietly worse.
     */
    it('shows on the row when a lesson changed a value', async () => {
      server.nextFields = [
        {
          ...FIELDS[0],
          value: 462_090_073,
          unitsMultiplier: 1,
          lessonNote:
            'Read as 1,000×; you confirmed this fund reports in 1s, so that is what was used.',
        },
      ];

      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');

      expect(await screen.findByText(/Applied what you confirmed/)).toBeInTheDocument();
      expect(screen.getByText(/you confirmed this fund reports in 1s/)).toBeInTheDocument();
      // The value shown is the one the lesson produced, not the model's.
      expect(screen.getByLabelText('total_investments value')).toHaveValue('462090073');
    });

    it('proposes a diagnosis with its reasoning and its reach', async () => {
      await corrected();

      expect(await screen.findByText('Wrong units')).toBeInTheDocument();
      expect(screen.getByText(/I applied the thousands heading/)).toBeInTheDocument();
      // Scope is the consequential part — stated in full, not as a tag.
      expect(
        screen.getByText('Would apply to every future document from this fund'),
      ).toBeInTheDocument();
      expect(screen.getByText(/check whether the investments section/)).toBeInTheDocument();
    });

    it('puts the summary in the chat alongside the proposal', async () => {
      await corrected();
      expect(
        await within(screen.getByRole('log')).findByText('Here is what I think went wrong.'),
      ).toBeInTheDocument();
    });

    /** Nothing becomes a rule without the analyst saying so. */
    it('records an acceptance against that lesson only', async () => {
      const user = await corrected({
        summary: 'Two things went wrong.',
        lessons: [UNITS_LESSON, { ...UNITS_LESSON, id: 'lesson-2', type: 'typo', scope: 'none', rule: '' }],
      });
      await screen.findByText('Wrong units');

      await user.click(screen.getByRole('button', { name: 'Remember this' }));

      expect(await screen.findByText(/Accepted/)).toBeInTheDocument();
      // The other proposal is untouched — agreeing with one implies nothing
      // about the rest of the batch.
      expect(screen.getByRole('button', { name: 'Agreed' })).toBeInTheDocument();
    });

    /** A lesson with nothing to remember should not offer to remember it. */
    it('offers plain agreement when there is no rule to learn', async () => {
      await corrected({
        summary: 'Just a slip.',
        lessons: [{ ...UNITS_LESSON, type: 'typo', scope: 'none', rule: '' }],
      });

      expect(await screen.findByRole('button', { name: 'Agreed' })).toBeInTheDocument();
      expect(
        screen.getByText('Applies to this document only — nothing will be remembered'),
      ).toBeInTheDocument();
    });

    /**
     * The correction goes on the lesson it refutes. Typed into the chat box it
     * would have to be matched back to a proposal by guessing, which is the
     * ambiguity this whole feature exists to remove.
     */
    it('takes a written correction attached to the proposal it refutes', async () => {
      const user = await corrected();
      await screen.findByText('Wrong units');

      await user.click(screen.getByRole('button', { name: "That's not it" }));
      expect(screen.getByRole('button', { name: 'Send correction' })).toBeDisabled();

      await user.type(
        screen.getByLabelText('What actually happened?'),
        'That page reports investments in whole dollars.',
      );
      await user.click(screen.getByRole('button', { name: 'Send correction' }));

      expect(await screen.findByText(/Rejected/)).toBeInTheDocument();
      expect(
        screen.getByText(/That page reports investments in whole dollars/),
      ).toBeInTheDocument();
    });

    it('says so when the corrections were stored but could not be explained', async () => {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');
      await user.type(screen.getByLabelText('Period ending'), '2025-06-30');
      await user.type(screen.getByLabelText('total_receivables value'), '1');
      await user.tab();

      // Corrections stored, explanation not. The server says so in the log.
      mockSubmitEdits.mockImplementation(async (analysisId) => {
        server.analyses.get(analysisId)!.messages.push({
          id: crypto.randomUUID(),
          author: 'agent',
          text: 'Your corrections were recorded, but I could not work out why they were needed. Anthropic is rate limiting us.',
          variant: 'error',
        });
        return {
          batchId: 'batch-1',
          received: 1,
          diagnosis: null,
          error: { code: 'RateLimited', message: 'Anthropic is rate limiting us.' },
        };
      });
      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      // Stored is not the same as explained, and the analyst should not have to
      // guess which of the two happened.
      expect(await screen.findByText(/could not work out why they were needed/)).toBeInTheDocument();
      expect(screen.getByText(/rate limiting/)).toBeInTheDocument();
    });
  });

  describe('writing to the customer system', () => {
    async function reviewed() {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');
      await user.type(screen.getByLabelText('Period ending'), '2025-06-30');
      return user;
    }

    /** The period is the customer's uniqueness key; writing without it would be
     *  refused anyway, and less clearly. */
    it('will not write without a reporting period', async () => {
      const user = userEvent.setup();
      await startAnalysis(user);
      await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByRole('table');

      expect(screen.getByRole('button', { name: 'Confirm and write' })).toBeDisabled();
    });

    it('sends the values on screen, corrections included', async () => {
      const user = await reviewed();
      await user.clear(screen.getByLabelText('total_investments value'));
      await user.type(screen.getByLabelText('total_investments value'), '999');

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      await waitFor(() => expect(mockWrite).toHaveBeenCalledOnce());
      const [, fundId, period, values] = mockWrite.mock.calls[0];
      expect(fundId).toBe(FUNDS[0].id);
      expect(period).toBe('2025-06-30');
      expect(values.total_investments).toBe('999');
      // A value the model never found is sent as empty, not omitted — their
      // schema decides whether a missing required field is acceptable.
      expect(values.total_receivables).toBe('');
    });

    /**
     * One call with the whole batch. Corrections made together are usually one
     * mistake seen from several angles, and asking about them separately would
     * find coincidences instead of a cause.
     */
    it('submits every correction together, after the values are accepted', async () => {
      const user = await reviewed();
      await user.type(screen.getByLabelText('total_receivables value'), '38456658000');
      await user.tab();
      await user.clear(screen.getByLabelText('total_investments value'));
      await user.type(screen.getByLabelText('total_investments value'), '462090073');
      await user.tab();

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      await waitFor(() => expect(mockSubmitEdits).toHaveBeenCalledOnce());
      const [, fundId, edits] = mockSubmitEdits.mock.calls[0];
      expect(fundId).toBe(FUNDS[0].id);
      expect(edits.map((e) => e.fieldKey).sort()).toEqual([
        'total_investments',
        'total_receivables',
      ]);
      // Provenance travels with the correction — step 10 needs it to explain why.
      expect(edits[0].context).toHaveProperty('sourceText');
    });

    it('does not submit corrections when the write was refused', async () => {
      const user = await reviewed();
      await user.type(screen.getByLabelText('total_receivables value'), '1');
      await user.tab();
      mockWrite.mockRejectedValue(
        new WriteRejected('The report was not stored.', 400, 'ValidationFailed', []),
      );

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      await screen.findByText('The report was not stored.');
      // Learning from a correction that was itself rejected would teach us the
      // wrong thing.
      expect(mockSubmitEdits).not.toHaveBeenCalled();
    });

    it('skips the call entirely when nothing was corrected', async () => {
      const user = await reviewed();
      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      await waitFor(() => expect(mockWrite).toHaveBeenCalledOnce());
      expect(mockSubmitEdits).not.toHaveBeenCalled();
    });

    it('locks the analysis once the customer has accepted it', async () => {
      const user = await reviewed();
      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      const log = screen.getByRole('log');
      expect(await within(log).findByText(/Written to the customer's system/)).toBeInTheDocument();
      expect(screen.getByText(/The customer's database owns these values now/)).toBeInTheDocument();
      expect(screen.getByLabelText('total_investments value')).toBeDisabled();
      expect(
        screen.queryByRole('button', { name: 'Confirm and write' }),
      ).not.toBeInTheDocument();
    });

    /**
     * The whole reason customer-system is a separate service. Their refusal is
     * theirs to explain, so their wording reaches the analyst unaltered.
     */
    it('shows the customer\'s rejection against the fields they named', async () => {
      const user = await reviewed();
      mockWrite.mockRejectedValue(
        new WriteRejected('The report was not stored.', 400, 'ValidationFailed', [
          { field: 'total_investments', reason: 'Must be a whole number of USD.' },
        ]),
      );

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      expect(await screen.findByText('Must be a whole number of USD.')).toBeInTheDocument();
      expect(screen.getByText('The report was not stored.')).toBeInTheDocument();
      // Still editable — the analyst has to be able to fix what was refused.
      expect(screen.getByLabelText('total_investments value')).toBeEnabled();
    });

    it('reports a duplicate report without pretending it succeeded', async () => {
      const user = await reviewed();
      mockWrite.mockRejectedValue(
        new WriteRejected(
          'A report for calpers ending 2025-06-30 is already on file.',
          409,
          'ReportAlreadyExists',
          [],
        ),
      );

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      expect(await screen.findByText(/already on file/)).toBeInTheDocument();
      expect(screen.queryByText(/database owns these values/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm and write' })).toBeEnabled();
    });

    it('clears a rejection once the analyst changes the value it named', async () => {
      const user = await reviewed();
      mockWrite.mockRejectedValue(
        new WriteRejected('The report was not stored.', 400, 'ValidationFailed', [
          { field: 'total_investments', reason: 'Must be a whole number of USD.' },
        ]),
      );
      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));
      await screen.findByText('Must be a whole number of USD.');

      await user.type(screen.getByLabelText('total_investments value'), '0');

      // Still complaining about a value they have since fixed would be worse
      // than not complaining at all.
      expect(screen.queryByText('Must be a whole number of USD.')).not.toBeInTheDocument();
    });

    it('surfaces an unreachable customer system as its own failure', async () => {
      const user = await reviewed();
      mockWrite.mockRejectedValue(
        new WriteRejected('The customer system could not be reached.', 502, 'CustomerSystemUnavailable', []),
      );

      await user.click(screen.getByRole('button', { name: 'Confirm and write' }));

      expect(await screen.findByText(/could not be reached/)).toBeInTheDocument();
      expect(screen.queryByText(/database owns these values/)).not.toBeInTheDocument();
    });
  });

  it('does not mark a real reply as recorded', async () => {
    const user = userEvent.setup();
    await startAnalysis(user);

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText(AGENT_TEXT);
    expect(screen.queryByText('recorded')).not.toBeInTheDocument();
  });

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
    // Documents stored, model unreachable. The server says so in the log.
    mockUpload.mockImplementation(async (analysisId, _fundId, files, prompt) => {
      const analysis = server.analyses.get(analysisId)!;
      analysis.messages.push({
        id: crypto.randomUUID(),
        author: 'agent',
        text: 'Your documents are stored, but extraction failed. Anthropic is rate limiting us.',
        variant: 'error',
      });
      return {
        uploadId: 'u',
        analysisId,
        prompt,
        documents: files.map((f, i) => ({ id: `d${i}`, filename: f.name, size: f.size })),
        agent: null,
        agentError: { code: 'RateLimited', message: 'Anthropic is rate limiting us.' },
      };
    });

    await user.upload(screen.getByLabelText(/Choose documents/), pdf('acfr.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/documents are stored, but extraction failed/)).toBeInTheDocument();
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
    const [analysisId, fundId, files, prompt] = mockUpload.mock.calls[0];
    expect(analysisId).toMatch(/^[0-9a-f-]{36}$/);
    // The fund was chosen on the landing page; extraction needs to know which.
    expect(fundId).toBe(FUNDS[0].id);
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
    expect(mockUpload.mock.calls[0][2].map((f) => f.name)).toEqual(['good.pdf']);
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

    // Restore only the upload behaviour — resetting the whole fake would delete
    // the analysis this test is sitting in.
    server.restoreUpload();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(AGENT_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('Additional context')).toHaveValue('');
  });
});
