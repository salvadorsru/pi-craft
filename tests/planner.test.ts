import { describe, expect, test } from "bun:test";
import {
  cleanStepText,
  displayStepText,
  extractPlanSteps,
} from "../src/plan/planner.ts";

describe("extractPlanSteps", () => {
  test("stops at a later section instead of swallowing its numbered items", () => {
    const message = `Analysis.

Plan:
1. Fix the parser in \`src/planner.ts\`.
2. Keep the full step text.
3. Add the execution context.

Preguntas:
1. ¿Instalar desde npm o desde git?
2. ¿Quieres una lista viva en el transcript?`;

    const steps = extractPlanSteps(message);

    expect(steps.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.text)).toEqual([
      "Fix the parser in src/planner.ts.",
      "Keep the full step text.",
      "Add the execution context.",
    ]);
    expect(steps.some((s) => s.text.includes("Instalar"))).toBe(false);
  });

  test("does not truncate the stored step text", () => {
    const step = "A".repeat(200);
    const [item] = extractPlanSteps(`Plan:\n1. ${step}\n`);
    expect(item?.text.length).toBe(200);
  });

  test("discards question-shaped items", () => {
    const steps = extractPlanSteps(
      "Plan:\n1. Do the work.\n2. ¿Should this be a step?\n3. Should this be a step?\n",
    );
    expect(steps.map((s) => s.text)).toEqual(["Do the work."]);
  });

  test("supports a heading without a colon", () => {
    const steps = extractPlanSteps("## Plan\n1. First real step\n2. Second real step\n");
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
  });

  test("numbers a bullet-only plan", () => {
    const steps = extractPlanSteps("Plan:\n- First real step\n- Second real step\n");
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
  });

  test("keeps indented plain-text continuations with the previous step", () => {
    const steps = extractPlanSteps(
      "Plan:\n1. First line of the step\n   and its continuation.\n",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.text).toContain("continuation");
  });

  test("parses a bold-wrapped number", () => {
    const steps = extractPlanSteps(
      "Plan:\n**1. First real step**\n**2. Second real step**\n",
    );
    expect(steps.map((s) => s.text)).toEqual([
      "First real step",
      "Second real step",
    ]);
  });

  test("reads a header that carries its own title", () => {
    const steps = extractPlanSteps(
      "Plan: move the tests out\n1. First real step\n2. Second real step\n",
    );
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
  });

  test("skips a rule between steps", () => {
    const steps = extractPlanSteps(
      "Plan:\n1. First real step\n---\n2. Second real step\n",
    );
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
  });

  test("skips a heading between the header and the list", () => {
    const steps = extractPlanSteps("Plan:\n\n**Rules**\n\n1. First real step\n");
    expect(steps.map((s) => s.text)).toEqual(["First real step"]);
  });

  test("does not read a word that only starts with Plan", () => {
    expect(extractPlanSteps("Planning: 1. not a plan\n")).toHaveLength(0);
  });
});

describe("display helpers", () => {
  test("cleans markdown", () => {
    expect(cleanStepText("**Hello** `world` [link](https://example.com)")).toBe(
      "Hello world link",
    );
  });

  test("truncates only for display", () => {
    expect(displayStepText("x".repeat(120), 20)).toBe(`${"x".repeat(17)}...`);
    expect(displayStepText("short", 20)).toBe("short");
  });
});
