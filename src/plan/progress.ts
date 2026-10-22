/**
 * Progress tracking for plan execution.
 * Parses [DONE:n] markers from LLM output and updates step completion.
 */

import type { PlanStep } from "./types.js";

/**
 * Extract completed step numbers from [DONE:n] markers in text.
 */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * The words of a step, without the decoration: a re-statement that only changes
 * punctuation, case or emphasis is the same step.
 */
function key(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Carry the ticks of a plan onto its re-statement.
 *
 * A plan is often rewritten while it runs — the same steps, a new note, a step
 * rephrased after a mistake. Replacing the list must not undo what is done, so a step
 * keeps its tick when it has the same number and the same words; anything else is new
 * work and starts open.
 */
export function carryCompletion(previous: PlanStep[], next: PlanStep[]): PlanStep[] {
  const done = new Map(
    previous.map((step) => [`${step.step}:${key(step.text)}`, step.completed]),
  );
  return next.map((step) => ({
    ...step,
    completed: done.get(`${step.step}:${key(step.text)}`) ?? false,
  }));
}

/**
 * Mark steps as completed based on [DONE:n] markers found in text.
 * Returns the number of steps newly marked as completed.
 */
export function markCompletedSteps(text: string, items: PlanStep[]): number {
  const doneSteps = extractDoneSteps(text);
  let newlyCompleted = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      newlyCompleted++;
    }
  }
  return newlyCompleted;
}

/**
 * Calculate completion stats for a set of plan steps.
 */
export function getCompletionStats(steps: PlanStep[]): {
  completed: number;
  total: number;
  allDone: boolean;
} {
  const completed = steps.filter((s) => s.completed).length;
  return {
    completed,
    total: steps.length,
    allDone: steps.length > 0 && completed === steps.length,
  };
}
