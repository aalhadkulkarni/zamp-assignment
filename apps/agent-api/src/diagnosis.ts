/**
 * The five ways a correction can mean something, from CLAUDE.md. Same gesture,
 * very different blast radius — which is exactly why the agent has to say which
 * one it thinks this was, rather than just recording that a number changed.
 */
export const LESSON_TYPES = [
  'typo',
  'wrong_source',
  'units',
  'concept_confusion',
  'synonym',
] as const;

/**
 * How far a lesson reaches. This is the field that decides whether a correction
 * changes nothing, changes every future document from this fund, or changes
 * every document from everyone — so it is the one a human most needs to ratify.
 */
export const LESSON_SCOPES = ['none', 'fund', 'global'] as const;

export type LessonType = (typeof LESSON_TYPES)[number];
export type LessonScope = (typeof LESSON_SCOPES)[number];

export type Lesson = {
  /** Stable id so an accept or reject can name which lesson it refers to. */
  id: string;
  type: LessonType;
  scope: LessonScope;
  /** Which corrections this explains. Several fields can share one cause. */
  fieldKeys: string[];
  /** One or two sentences an analyst can ratify in seconds. */
  explanation: string;
  /** What would change next time, in plain language. */
  rule: string;
  /**
   * The multiplier the document actually uses, when the type is units. A number
   * because a units lesson is arithmetic we can check ourselves, and asking the
   * model to restate "in thousands" as prose every time is asking it to make
   * the same judgement twice.
   */
  unitsMultiplier: number | null;
  /**
   * The label as printed, when the type is synonym or concept_confusion. This
   * rides with the field into the output schema, so it is the exact string the
   * next extraction is told to match on — or told to stay away from.
   */
  documentLabel: string;
  confidence: 'high' | 'medium' | 'low';
};

export type Diagnosis = {
  summary: string;
  lessons: Lesson[];
};

/**
 * Lessons are proposed against the whole batch rather than one per correction,
 * so the model can say "these four are one units mistake" instead of inventing
 * four unrelated causes. `fieldKeys` is what carries that grouping.
 *
 * `id` is generated here rather than asked for. A model inventing identifiers is
 * a way to get collisions and hallucinated references for no benefit.
 */
export function diagnosisSchema(fieldKeys: string[]) {
  return {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'Two or three sentences to the analyst about what you think went wrong. Plain prose, no markdown.',
      },
      lessons: {
        type: 'array',
        description:
          'One entry per distinct cause. Corrections that share a cause belong in the same entry.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [...LESSON_TYPES],
              description:
                'typo: a one-off slip, nothing to learn. wrong_source: the value was read from the wrong table, column or row. units: the figure was right but the scale was not. concept_confusion: a different concept was extracted than the one the field asks for. synonym: the label in this document was not recognised as this field.',
            },
            scope: {
              type: 'string',
              enum: [...LESSON_SCOPES],
              description:
                'none: applies to this document only, nothing should be remembered. fund: applies to every future document from this fund. global: applies to every document from every fund. Prefer the narrowest scope that fits.',
            },
            fieldKeys: {
              type: 'array',
              items: { type: 'string', enum: fieldKeys },
              description: 'The corrections this explains.',
            },
            explanation: {
              type: 'string',
              description:
                'Why you think this happened, addressed to the analyst. One or two sentences they can agree or disagree with quickly.',
            },
            rule: {
              type: 'string',
              description:
                'What you would do differently next time, stated as an instruction to yourself. Empty when the scope is none.',
            },
            unitsMultiplier: {
              type: ['number', 'null'],
              description:
                'Only when type is units: what the figures in this document are actually in, as a number — 1000 for thousands, 1000000 for millions. Null for every other type.',
            },
            documentLabel: {
              type: 'string',
              description:
                'Only when type is synonym or concept_confusion: the label exactly as printed in the document, copied character for character. For a synonym this is the label that should have been recognised; for a concept_confusion it is the label that was read by mistake. Empty string for every other type.',
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: [
            'type',
            'scope',
            'fieldKeys',
            'explanation',
            'rule',
            'unitsMultiplier',
            'documentLabel',
            'confidence',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'lessons'],
    additionalProperties: false,
  };
}
