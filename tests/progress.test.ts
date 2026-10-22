import { describe, expect, test } from "bun:test";
import {
  carryCompletion,
  extractDoneSteps,
  getCompletionStats,
  markCompletedSteps,
} from "../src/plan/progress.ts";
import type { PlanStep } from "../src/plan/types.ts";

function steps(...texts: string[]): PlanStep[] {
  return texts.map((text, index) => ({ step: index + 1, text, completed: false }));
}

describe("extractDoneSteps", () => {
  test("reads every marker, whatever its case", () => {
    expect(extractDoneSteps("work [DONE:1] and [done:3]")).toEqual([1, 3]);
    expect(extractDoneSteps("no marker here")).toEqual([]);
  });
});

describe("markCompletedSteps", () => {
  test("marks only the steps the markers name", () => {
    const list = steps("one", "two", "three");
    expect(markCompletedSteps("done with [DONE:2]", list)).toBe(1);
    expect(list.map((step) => step.completed)).toEqual([false, true, false]);
  });

  test("a marker for a step that is already done is not counted twice", () => {
    const list = steps("one");
    expect(markCompletedSteps("[DONE:1]", list)).toBe(1);
    expect(markCompletedSteps("[DONE:1]", list)).toBe(0);
  });

  test("a marker for a step nobody planned changes nothing", () => {
    const list = steps("one");
    expect(markCompletedSteps("[DONE:9]", list)).toBe(0);
    expect(list[0].completed).toBe(false);
  });
});

describe("carryCompletion", () => {
  test("a re-statement keeps the ticks of the steps it repeats", () => {
    const before = steps("Fix the parser", "Add tests");
    before[0].completed = true;

    const after = carryCompletion(before, steps("Fix the parser", "Add tests"));
    expect(after.map((step) => step.completed)).toEqual([true, false]);
  });

  test("decoration, case and spacing are not a different step", () => {
    const before = steps("Fix the `parser` in src");
    before[0].completed = true;

    const after = carryCompletion(before, steps("fix the parser in   SRC".replace("SRC", "src")));
    expect(after[0].completed).toBe(true);
  });

  test("different words or a different number start open", () => {
    const before = steps("Fix the parser", "Add tests");
    before[0].completed = true;

    const rephrased = carryCompletion(before, steps("Rewrite the parser", "Add tests"));
    expect(rephrased[0].completed).toBe(false);
    expect(rephrased[1].completed).toBe(false);

    const moved = carryCompletion(before, [
      { step: 2, text: "Fix the parser", completed: false },
    ]);
    expect(moved[0].completed).toBe(false);
  });

  test("a longer plan starts its new steps open and keeps the old ones", () => {
    const before = steps("First");
    before[0].completed = true;
    const after = carryCompletion(before, steps("First", "Second"));
    expect(after.map((step) => step.completed)).toEqual([true, false]);
  });
});

describe("getCompletionStats", () => {
  test("counts what is done and says when it is over", () => {
    const list = steps("one", "two");
    expect(getCompletionStats(list)).toEqual({ completed: 0, total: 2, allDone: false });
    list[0].completed = true;
    list[1].completed = true;
    expect(getCompletionStats(list)).toEqual({ completed: 2, total: 2, allDone: true });
    expect(getCompletionStats([])).toEqual({ completed: 0, total: 0, allDone: false });
  });
});
