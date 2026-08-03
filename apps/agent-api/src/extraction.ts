import type { FieldDefinition } from './customer.js';

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

export type Extraction = {
  summary: string;
  fields: ExtractedField[];
};

/** What we hand to the analyst: the model's answer plus the arithmetic we did. */
export type ReviewField = ExtractedField & {
  /** valueAsPrinted × unitsMultiplier, in whole USD. Null when nothing was found. */
  value: number | null;
};

/**
 * The model reports the printed figure and the multiplier separately, and we do
 * the multiplication. Asking it to return 462090073000 directly buries the units
 * decision inside a number nobody can check; this way the judgement is a single
 * inspectable field, the arithmetic is deterministic, and a units correction is
 * "the multiplier was wrong" rather than "the value was wrong by some factor".
 */
export function applyUnits(field: ExtractedField): ReviewField {
  const value =
    field.valueAsPrinted === null ? null : Math.round(field.valueAsPrinted * field.unitsMultiplier);
  return { ...field, value };
}

/**
 * Built from the customer's field definitions rather than hardcoded, so the
 * model can only name fields that exist. An enum here removes a whole class of
 * rejection — it cannot invent `funded_ratio` and have customer-system refuse it
 * three steps later.
 */
export function extractionSchema(fields: FieldDefinition[]) {
  return {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'Two or three sentences for the analyst: what was found, what was not, and anything ambiguous. Plain prose, no markdown.',
      },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: fields.map((f) => f.key) },
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
            'key',
            'valueAsPrinted',
            'unitsMultiplier',
            'confidence',
            'sourcePage',
            'sourceText',
            'reasoning',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'fields'],
    additionalProperties: false,
  };
}
