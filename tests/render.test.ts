import { describe, expect, test } from "bun:test";
import {
  cardLines,
  formatDuration,
  progressBar,
  summaryText,
  textWidth,
  widgetLines,
} from "../src/plan/render.ts";
import type { PlanStep } from "../src/plan/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const steps: PlanStep[] = [
  { step: 1, text: "Fix the parser in src/planner.ts.", completed: true },
  { step: 2, text: "Keep the full step text.", completed: false },
  { step: 3, text: "Add the execution context.", completed: false },
];

describe("formatDuration", () => {
  test("stays compact", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_663_000)).toBe("1h 01m");
  });
});

describe("progressBar", () => {
  test("fills exactly the requested width", () => {
    expect(textWidth(progressBar(1, 2, 10, theme))).toBe(10);
    expect(progressBar(1, 2, 10, theme)).toBe("#####-----");
    expect(progressBar(0, 0, 4, theme)).toBe("----");
  });
});

describe("widgetLines", () => {
  test("shows the counter, the bar and one line per step", () => {
    const lines = widgetLines(steps, theme, 80);
    expect(lines[0]).toContain("1/3");
    expect(lines[0]).toContain("33%");
    expect(lines[1]).toContain("[x] 1. Fix the parser");
    expect(lines[2]).toContain("[>] 2. Keep the full step text.");
    expect(lines[3]).toContain("[ ] 3. Add the execution context.");
  });

  test("truncates instead of wrapping, so the height stays fixed", () => {
    const long: PlanStep[] = [
      { step: 1, text: "A".repeat(200), completed: false },
    ];
    const lines = widgetLines(long, theme, 40);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(40);
    expect(lines[1]).toEndWith("…");
  });

  test("can list a plan without a progress bar", () => {
    const lines = widgetLines(steps, theme, 80, { progress: false, current: false });
    expect(lines[0]).toContain("3 steps");
    expect(lines[0]).not.toContain("%");
    expect(lines.join("\n")).not.toContain("[>]");
  });

  test("keeps a fixed height on a long plan and follows the current step", () => {
    const long: PlanStep[] = Array.from({ length: 20 }, (_, index) => ({
      step: index + 1,
      text: `Step ${index + 1}`,
      completed: index < 9,
    }));

    const lines = widgetLines(long, theme, 80);
    const text = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(8);
    expect(text).toContain("[>]");
    expect(text).toContain("… 7 above");
    expect(text).toContain("… 8 below");
  });
});

describe("cardLines", () => {
  test("repeats the full text, wrapped to the width", () => {
    const long =
      "Refactor the execution context so the remaining checklist and the done marker reach the model even when the run is already streaming and before_agent_start is not called again.";
    const list: PlanStep[] = [
      { step: 1, text: long, completed: true },
      { step: 2, text: "Short one.", completed: true },
    ];
    const lines = cardLines(list, theme, 40, {
      title: "Plan complete",
      summary: "2/2 steps · 3s",
    });

    expect(lines[0]).toBe("Plan complete");
    expect(lines[1]).toBe("2/2 steps · 3s");
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(40);

    const text = lines.join(" ");
    expect(text).toContain("Refactor the execution context");
    expect(text).toContain("before_agent_start is not called again.");
    expect(text).toContain("Short one.");
  });

  test("does not loop on a character wider than the line", () => {
    const list: PlanStep[] = [{ step: 1, text: "中文中文", completed: false }];
    const lines = cardLines(list, theme, 1, { title: "Plan" });
    expect(lines.join("")).toContain("中文中文");
  });

  test("lists changed files only when expanded", () => {
    const collapsed = cardLines(steps, theme, 60, {
      title: "Plan complete",
      files: ["src/a.ts", "src/b.ts"],
      expanded: false,
    }).join("\n");
    expect(collapsed).not.toContain("src/a.ts");

    const expanded = cardLines(steps, theme, 60, {
      title: "Plan complete",
      files: ["src/a.ts", "src/b.ts"],
      expanded: true,
    }).join("\n");
    expect(expanded).toContain("2 files changed");
    expect(expanded).toContain("src/a.ts");
    expect(expanded).toContain("src/b.ts");
  });
});

describe("no strikethrough", () => {
  test("never draws completed steps as struck through", () => {
    const list: PlanStep[] = [
      { step: 1, text: "Done step", completed: true },
      { step: 2, text: "Pending step", completed: false },
    ];

    const widget = widgetLines(list, theme, 80).join("\n");
    const card = cardLines(list, theme, 80, {
      title: "Plan complete",
      summary: "2/2 steps",
      final: true,
    }).join("\n");

    expect(widget).not.toContain("~~");
    expect(card).not.toContain("~~");
    expect(widget).toContain("[x] 1. Done step");
    expect(card).toContain("[x] 1. Done step");
  });
});

describe("summaryText", () => {
  test("summarises steps, duration and changed files", () => {
    expect(summaryText(3, 3, 134_000, 2)).toBe("3/3 steps · 2m 14s · 2 files changed");
    expect(summaryText(1, 1)).toBe("1/1 step");
    expect(summaryText(1, 2, 5_000, 1)).toBe("1/2 steps · 5s · 1 file changed");
  });
});
