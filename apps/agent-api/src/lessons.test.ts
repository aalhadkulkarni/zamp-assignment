import { describe, expect, it } from 'vitest';
import type { StoredLesson } from './analyses.js';
import { describePlan, planLessons } from './lessons.js';

/**
 * The brief's anti-goal in test form. Every assertion here is about a lesson
 * landing somewhere a lesson of a different type could not land — if these all
 * passed with one shared "notes" array, the separation would be decorative.
 */

function lesson(overrides: Partial<StoredLesson>): StoredLesson {
  return {
    id: 'l1',
    type: 'typo',
    scope: 'fund',
    fieldKey: 'net_position',
    sharedWith: [],
    explanation: 'because',
    rule: '',
    unitsMultiplier: null,
    documentLabel: '',
    confidence: 'high',
    corrections: [],
    ...overrides,
  };
}

describe('planLessons', () => {
  it('attaches a synonym to the field it is a synonym for', () => {
    const plan = planLessons([
      lesson({ type: 'synonym', fieldKey: 'net_position', documentLabel: 'Plan Net Assets' }),
    ]);

    expect(plan.guidance.get('net_position')).toEqual({
      alsoPrintedAs: ['Plan Net Assets'],
      notThis: [],
    });
    // Not the prompt, and not the arithmetic.
    expect(plan.navigation).toEqual([]);
    expect(plan.expectedMultiplier).toBeNull();
  });

  /**
   * A synonym and a concept confusion are opposite claims about the same field.
   * Flattened into one list of notes they would cancel out, which is the
   * concrete reason the two are kept apart rather than a stylistic one.
   */
  it('keeps a concept confusion opposite to a synonym on the same field', () => {
    const plan = planLessons([
      lesson({ type: 'synonym', fieldKey: 'net_position', documentLabel: 'Plan Net Assets' }),
      lesson({
        id: 'l2',
        type: 'concept_confusion',
        fieldKey: 'net_position',
    sharedWith: [],
        documentLabel: 'Total Fund Balance',
      }),
    ]);

    expect(plan.guidance.get('net_position')).toEqual({
      alsoPrintedAs: ['Plan Net Assets'],
      notThis: ['Total Fund Balance'],
    });
  });

  it('sends a source rule to the prompt and nowhere else', () => {
    const plan = planLessons([
      lesson({ type: 'wrong_source', rule: 'Read the Total column.', documentLabel: '' }),
    ]);

    expect(plan.navigation).toEqual(['Read the Total column.']);
    expect(plan.guidance.size).toBe(0);
  });

  it('turns a units lesson into a number, not a sentence', () => {
    const plan = planLessons([lesson({ type: 'units', unitsMultiplier: 1000 })]);

    expect(plan.expectedMultiplier).toBe(1000);
    expect(plan.navigation).toEqual([]);
    expect(plan.guidance.size).toBe(0);
  });

  /** The analyst's most recent word wins; an issuer can change how it reports. */
  it('lets the newest ratified units answer win', () => {
    const plan = planLessons([
      lesson({ type: 'units', unitsMultiplier: 1000 }),
      lesson({ id: 'l2', type: 'units', unitsMultiplier: 1 }),
    ]);

    expect(plan.expectedMultiplier).toBe(1);
  });

  /**
   * The point of diagnosing before learning. A system that cannot conclude
   * "nothing to learn" turns every slip into a standing rule.
   */
  it('does nothing at all with a typo', () => {
    const plan = planLessons([lesson({ type: 'typo' })]);

    expect(plan).toMatchObject({ navigation: [], expectedMultiplier: null, applied: [] });
    expect(plan.guidance.size).toBe(0);
  });

  /** A model that says "units" without a number has not taught us anything. */
  it('ignores a lesson missing the payload its type needs', () => {
    const plan = planLessons([
      lesson({ type: 'units', unitsMultiplier: null }),
      lesson({ id: 'l2', type: 'synonym', documentLabel: '' }),
      lesson({ id: 'l3', type: 'wrong_source', rule: '' }),
    ]);

    expect(plan.applied).toEqual([]);
  });
});

describe('describePlan', () => {
  it('says nothing when nothing was applied', () => {
    expect(describePlan(planLessons([lesson({ type: 'typo' })]))).toBe('');
  });

  /** Applying a ratified rule invisibly would undo the point of ratifying it. */
  it('counts what it applied, by type', () => {
    const text = describePlan(
      planLessons([
        lesson({ type: 'synonym', documentLabel: 'Plan Net Assets' }),
        lesson({
          id: 'l2',
          type: 'synonym',
          fieldKey: 'total_assets',
          documentLabel: 'Fiduciary Net Position',
        }),
        lesson({ id: 'l3', type: 'units', unitsMultiplier: 1000 }),
      ]),
    );

    expect(text).toContain('2 labels you told me to recognise');
    expect(text).toContain('1 rule about units');
  });
});
