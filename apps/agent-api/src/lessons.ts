import type { StoredLesson } from './analyses.js';
import type { LessonType } from './diagnosis.js';

/**
 * Turning ratified lessons into things the next extraction actually does.
 *
 * The brief's anti-goal is the reason this file exists: if all five lesson types
 * end up as sentences in one prompt, we have built one thing with five labels.
 * So each type is sorted here to a different place in the pipeline, and the
 * shapes below are deliberately not interchangeable — a units lesson is a
 * number, a synonym is a label bound to a field, a source rule is prose about
 * navigating a document. You could not swap one for another if you tried.
 */

/** What a single field has been taught. Attached to it in the output schema. */
export type FieldNotes = {
  /** Labels confirmed to mean this field. */
  alsoPrintedAs: string[];
  /** Labels confirmed to mean something else, however similar they look. */
  notThis: string[];
};

export type FieldGuidance = Map<string, FieldNotes>;

export type LessonPlan = {
  /** Injected per field into the output schema. Never seen by the prompt. */
  guidance: FieldGuidance;
  /** Injected into the prompt's document-reading section. */
  navigation: string[];
  /**
   * Enforced after the model answers, in code. Null when nothing was ratified
   * about this fund's units.
   */
  expectedMultiplier: number | null;
  /** Which lessons ended up doing something. For telling the analyst. */
  applied: StoredLesson[];
};

export const EMPTY_PLAN: LessonPlan = {
  guidance: new Map(),
  navigation: [],
  expectedMultiplier: null,
  applied: [],
};

/**
 * Sorts accepted lessons to their application points.
 *
 * Everything arriving here has already been ratified by an analyst and filtered
 * to this fund — see `applicableLessons`. What is left to decide is *where* each
 * one acts, which is a property of its type and nothing else.
 *
 * `typo` is listed and does nothing on purpose. A system that cannot conclude
 * "nothing to learn here" would turn every slip of a keyboard into a standing
 * rule, and a wrong standing rule is worse than no rule at all: it is applied
 * silently, to every future document, by something the analyst has been told to
 * trust.
 */
export function planLessons(lessons: StoredLesson[]): LessonPlan {
  const plan: LessonPlan = {
    guidance: new Map(),
    navigation: [],
    expectedMultiplier: null,
    applied: [],
  };

  for (const lesson of lessons) {
    switch (lesson.type) {
      case 'typo':
        // Deliberately nothing.
        continue;

      case 'synonym': {
        if (!lesson.documentLabel || !lesson.fieldKey) continue;
        notesFor(plan.guidance, lesson.fieldKey).alsoPrintedAs.push(lesson.documentLabel);
        break;
      }

      case 'concept_confusion': {
        if (!lesson.documentLabel || !lesson.fieldKey) continue;
        notesFor(plan.guidance, lesson.fieldKey).notThis.push(lesson.documentLabel);
        break;
      }

      case 'wrong_source': {
        if (!lesson.rule) continue;
        plan.navigation.push(lesson.rule);
        break;
      }

      case 'units': {
        if (lesson.unitsMultiplier === null || lesson.unitsMultiplier <= 0) continue;
        // Lessons arrive oldest first, so the newest ratified answer wins. An
        // issuer that changes how it reports is a correction we will be told
        // about again, and the analyst's most recent word should be the one
        // standing.
        plan.expectedMultiplier = lesson.unitsMultiplier;
        break;
      }
    }
    plan.applied.push(lesson);
  }

  return plan;
}

function notesFor(guidance: FieldGuidance, key: string): FieldNotes {
  let notes = guidance.get(key);
  if (!notes) {
    notes = { alsoPrintedAs: [], notThis: [] };
    guidance.set(key, notes);
  }
  return notes;
}

/**
 * What to tell the analyst, in the chat, before the summary of what was found.
 *
 * Applying a ratified rule invisibly would undo the point of ratifying it. They
 * agreed to a rule once; they need to see it acting, or the next wrong value
 * looks like the model getting worse rather than a rule that needs revising.
 */
export function describePlan(plan: LessonPlan): string {
  if (plan.applied.length === 0) return '';

  const counts = new Map<LessonType, number>();
  for (const lesson of plan.applied) {
    counts.set(lesson.type, (counts.get(lesson.type) ?? 0) + 1);
  }

  const phrases = [...counts].map(([type, count]) => `${count} ${PHRASES[type](count)}`);
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;

  return `Before reading, I applied what you have confirmed for this fund: ${list}.`;
}

const PHRASES: Record<LessonType, (n: number) => string> = {
  synonym: (n) => (n === 1 ? 'label you told me to recognise' : 'labels you told me to recognise'),
  concept_confusion: (n) => (n === 1 ? 'concept to keep apart' : 'concepts to keep apart'),
  wrong_source: (n) => (n === 1 ? 'rule about where to read' : 'rules about where to read'),
  units: (n) => (n === 1 ? 'rule about units' : 'rules about units'),
  // Never reached: a typo is never applied, so it is never counted.
  typo: () => 'noted',
};
