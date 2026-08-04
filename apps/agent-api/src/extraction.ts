import type { FieldDefinition } from './customer.js';
import type { FieldGuidance, FieldNotes } from './lessons.js';

/**
 * What the model is asked to return. The prose lives inside the object rather
 * than beside it: structured outputs constrain the whole response, so a summary
 * that is a schema field is the only way to get both the chat message and the
 * table from one answer. It also keeps them honest — the sentence explaining a
 * blank is written by the same pass that left it blank.
 */
export type ExtractedField = {
  key: string;
  /** Exactly as printed in the document, before any units conversion. */
  valueAsPrinted: number | null;
  /** What the document says its figures are in. 1000 for "Dollars in Thousands". */
  unitsMultiplier: number;
  confidence: 'high' | 'medium' | 'low';
  sourcePage: number | null;
  sourceText: string;
  reasoning: string;
};

/**
 * What the model believes it has been handed, before it reads anything out of it.
 *
 * Three answers, not two. Many ACFR pages never name their issuer — a statement
 * of fiduciary net position mid-document often carries no fund name at all — so
 * "I cannot tell" has to be sayable. Treating silence as a mismatch would refuse
 * correct documents, and a false refusal is expensive: the analyst has the right
 * pages and is being told they do not.
 */
export type DocumentCheck = {
  /** What the document appears to be about, in the model's own words. */
  describes: string;
  verdict: 'matches' | 'mismatch' | 'cannot_tell';
  reasoning: string;
};

export type Extraction = {
  document: DocumentCheck;
  summary: string;
  /** Keyed by field, because the schema names one property per field. */
  fields: Record<string, Omit<ExtractedField, 'key'>>;
};

/** What we hand to the analyst: the model's answer plus the arithmetic we did. */
export type ReviewField = ExtractedField & {
  /** valueAsPrinted × unitsMultiplier, in whole USD. Null when nothing was found. */
  value: number | null;
  /** Set when a ratified lesson changed this row after the model answered. */
  lessonNote?: string;
};

/**
 * The model reports the printed figure and the multiplier separately, and we do
 * the multiplication. Asking it to return 462090073000 directly buries the units
 * decision inside a number nobody can check; this way the judgement is a single
 * inspectable field, the arithmetic is deterministic, and a units correction is
 * "the multiplier was wrong" rather than "the value was wrong by some factor".
 */
export function applyUnits(field: ExtractedField, expectedMultiplier: number | null): ReviewField {
  // A ratified units lesson wins over the model's reading of the units heading.
  // That heading is exactly what it got wrong the time the analyst corrected it,
  // and a human has since said what this issuer actually reports in. It is the
  // largest single thing this system does on its own — a factor of a thousand,
  // silently — so it is also the one that has to announce itself on the row.
  const corrected =
    expectedMultiplier !== null && expectedMultiplier !== field.unitsMultiplier;
  const multiplier = corrected ? expectedMultiplier : field.unitsMultiplier;

  const value =
    field.valueAsPrinted === null ? null : Math.round(field.valueAsPrinted * multiplier);

  return {
    ...field,
    unitsMultiplier: multiplier,
    value,
    ...(corrected
      ? {
          lessonNote: `Read as ${field.unitsMultiplier.toLocaleString('en-US')}×; you confirmed this fund reports in ${multiplier.toLocaleString('en-US')}s, so that is what was used.`,
        }
      : {}),
  };
}

/** The model answers by field name; the rest of the system works in rows. */
export function toReviewFields(
  extraction: Extraction,
  expectedMultiplier: number | null,
): ReviewField[] {
  return Object.entries(extraction.fields).map(([key, field]) =>
    applyUnits({ ...field, key }, expectedMultiplier),
  );
}

/**
 * Built from the customer's field definitions rather than hardcoded, so the
 * model can only name fields that exist. It cannot invent `funded_ratio` and
 * have customer-system refuse it three steps later.
 *
 * One named property per field, rather than an array of objects carrying a key.
 * An array lets the model return four entries for five fields, or the same field
 * twice, and both are failures we would only notice downstream. Named properties
 * make the shape of a complete answer part of the contract.
 *
 * It also gives each field somewhere of its own to carry instructions, which is
 * what `guidance` fills. A synonym the analyst ratified belongs on the field it
 * is a synonym for — not in a paragraph of prose about all the fields at once.
 */
export function extractionSchema(fields: FieldDefinition[], guidance?: FieldGuidance) {
  const properties: Record<string, unknown> = {};

  for (const field of fields) {
    properties[field.key] = {
      type: 'object',
      description: describeField(field, guidance?.get(field.key)),
      properties: {
        valueAsPrinted: {
          type: ['number', 'null'],
          description: 'The figure exactly as printed, without applying units. Null if absent.',
        },
        unitsMultiplier: {
          type: 'number',
          description:
            'What the document states its figures are in: 1 for whole dollars, 1000 for thousands, 1000000 for millions.',
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        sourcePage: { type: ['integer', 'null'] },
        sourceText: {
          type: 'string',
          description: 'The line as it appears in the document, quoted verbatim.',
        },
        reasoning: {
          type: 'string',
          description:
            'Why this line and this column. Name the section and, where a table has several columns, which one.',
        },
      },
      required: [
        'valueAsPrinted',
        'unitsMultiplier',
        'confidence',
        'sourcePage',
        'sourceText',
        'reasoning',
      ],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      document: {
        type: 'object',
        description:
          'What you have been handed. Answer this before reading any figures out of it.',
        properties: {
          describes: {
            type: 'string',
            description:
              'Which issuer and which period these pages appear to be about, as best you can tell from them. Say so plainly if nothing on them identifies either.',
          },
          verdict: {
            type: 'string',
            enum: ['matches', 'mismatch', 'cannot_tell'],
            description:
              'matches: these pages are this fund. mismatch: they are positively a different issuer — only when something on the page names one. cannot_tell: nothing here identifies the issuer either way, which is common and is not a problem.',
          },
          reasoning: {
            type: 'string',
            description: 'What on the page led you to that, quoted where you can.',
          },
        },
        required: ['describes', 'verdict', 'reasoning'],
        additionalProperties: false,
      },
      summary: {
        type: 'string',
        description:
          'Two or three sentences for the analyst: what was found, what was not, and anything ambiguous. Plain prose, no markdown.',
      },
      fields: {
        type: 'object',
        properties,
        required: fields.map((f) => f.key),
        additionalProperties: false,
      },
    },
    required: ['document', 'summary', 'fields'],
    additionalProperties: false,
  };
}

/**
 * The field's own description, plus anything the analyst has ratified about it.
 *
 * A synonym reads as an instruction to match; a concept confusion reads as an
 * instruction not to. They are opposite claims about the same field and would
 * cancel each other out if flattened into one list of "notes".
 */
function describeField(field: FieldDefinition, guidance: FieldNotes | undefined): string {
  const parts = [`${field.label}. ${field.description}`];

  if (guidance?.alsoPrintedAs.length) {
    parts.push(
      `In this issuer's reports this has also been printed as ${quoteList(guidance.alsoPrintedAs)}. An analyst confirmed that label means this field.`,
    );
  }
  if (guidance?.notThis.length) {
    parts.push(
      `Do not read ${quoteList(guidance.notThis)} for this field. An analyst confirmed that is a different concept, however similar the label looks.`,
    );
  }
  return parts.join(' ');
}

function quoteList(labels: string[]): string {
  const quoted = labels.map((l) => `"${l}"`);
  return quoted.length === 1
    ? quoted[0]
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
