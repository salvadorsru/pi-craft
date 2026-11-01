import { describe, expect, test } from "bun:test";
import {
  DONE_OPTION,
  MORE_OPTION,
  MORE_TITLE,
  OTHER_OPTION,
  answerText,
  askQuestion,
  questionCallLines,
  questionResultLines,
  type QuestionUI,
} from "../src/plan/question.ts";

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

function fakeUI(overrides: Partial<QuestionUI> = {}): QuestionUI {
  return {
    select: async () => undefined,
    input: async () => undefined,
    ...overrides,
  };
}

describe("askQuestion", () => {
  test("rejects an empty question", async () => {
    await expect(
      askQuestion(fakeUI(), { question: "   " }),
    ).rejects.toThrow("non-empty question");
  });

  test("returns a single selected option", async () => {
    const seen: string[][] = [];
    const answer = await askQuestion(
      fakeUI({
        select: async (_title, options) => {
          seen.push(options);
          return "Postgres";
        },
      }),
      { question: "Which database?", options: ["Postgres", "SQLite"] },
    );

    expect(seen).toEqual([["Postgres", "SQLite", OTHER_OPTION]]);
    expect(answer).toEqual({
      question: "Which database?",
      answer: "Postgres",
      cancelled: false,
    });
  });

  test("can hide the Other entry", async () => {
    let seen: string[] = [];
    await askQuestion(
      fakeUI({
        select: async (_title, options) => {
          seen = options;
          return "Postgres";
        },
      }),
      { question: "Which database?", options: ["Postgres"], allowOther: false },
    );

    expect(seen).toEqual(["Postgres"]);
  });

  test("collects several answers when multiple is set", async () => {
    const picks = ["Postgres", "Redis"];
    const rounds = [MORE_OPTION, DONE_OPTION];
    const answer = await askQuestion(
      fakeUI({
        select: async (title) =>
          title === MORE_TITLE ? rounds.shift() : picks.shift(),
      }),
      {
        question: "Which services?",
        options: ["Postgres", "Redis"],
        multiple: true,
      },
    );

    expect(answer.answer).toBe("- Postgres\n- Redis");
  });

  test("does not add a repeated option twice", async () => {
    const picks = ["Postgres", "Postgres"];
    const rounds = [MORE_OPTION, DONE_OPTION];
    const answer = await askQuestion(
      fakeUI({
        select: async (title) =>
          title === MORE_TITLE ? rounds.shift() : picks.shift(),
      }),
      { question: "Which?", options: ["Postgres"], multiple: true },
    );

    expect(answer.answer).toBe("Postgres");
  });

  /// The reported loop: Enter on the dialog that follows an answer must finish,
  /// not ask the same question again.
  test("the finishing choice comes first after an answer", async () => {
    let seen: string[] = [];
    const answer = await askQuestion(
      fakeUI({
        select: async (title, options) => {
          if (title !== MORE_TITLE) return "Postgres";
          seen = options;
          return DONE_OPTION;
        },
      }),
      { question: "Which?", options: ["Postgres"], multiple: true },
    );

    expect(seen[0]).toBe(DONE_OPTION);
    expect(answer).toEqual({
      question: "Which?",
      answer: "Postgres",
      cancelled: false,
    });
  });

  test("dismissing a later round keeps the answers already given", async () => {
    const picks = ["Postgres", MORE_OPTION, undefined];
    const answer = await askQuestion(
      fakeUI({ select: async () => picks.shift() }),
      { question: "Which?", options: ["Postgres"], multiple: true },
    );

    expect(answer).toEqual({
      question: "Which?",
      answer: "Postgres",
      cancelled: false,
    });
  });

  test("treats a dismissed selector or empty custom answer as cancelled", async () => {
    const dismissed = await askQuestion(fakeUI(), {
      question: "Which?",
      options: ["A"],
    });
    expect(dismissed.cancelled).toBe(true);
    expect(dismissed.answer).toBeUndefined();

    const emptyCustom = await askQuestion(
      fakeUI({ select: async () => OTHER_OPTION, input: async () => "   " }),
      { question: "Which?", options: ["A"] },
    );
    expect(emptyCustom.cancelled).toBe(true);
  });

  test("trims custom answers", async () => {
    const answer = await askQuestion(
      fakeUI({ select: async () => OTHER_OPTION, input: async () => "  MySQL  " }),
      { question: "Which?", options: ["A"] },
    );
    expect(answer.answer).toBe("MySQL");
  });

  test("returns cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const answer = await askQuestion(
      fakeUI({ select: async () => "A" }),
      { question: "Which?", options: ["A"] },
      controller.signal,
    );

    expect(answer.cancelled).toBe(true);
  });
});

describe("question rendering", () => {
  test("never presents a dismissal as an answer", () => {
    const text = answerText({ question: "Which?", cancelled: true });
    expect(text).toContain("dismissed");
    expect(text).toContain("Do not ask it again");
  });

  test("shows the answer and repeats the question when expanded", () => {
    const result = {
      question: "Which database?",
      answer: "- Postgres\n- Redis",
      cancelled: false,
    };

    const collapsed = questionResultLines(result, theme, false).join("\n");
    expect(collapsed).toContain("[success]> [/success]");
    expect(collapsed).toContain("Postgres");
    expect(collapsed).toContain("Redis");
    expect(collapsed).not.toContain("Which database?");

    const expanded = questionResultLines(result, theme, true).join("\n");
    expect(expanded).toContain("Which database?");
  });

  test("lists the suggestions only when the call is expanded", () => {
    const params = { question: "Which?", options: ["Postgres", "SQLite"] };

    expect(questionCallLines(params, theme, false)).toHaveLength(2);
    const expanded = questionCallLines(params, theme, true);
    expect(expanded.join("\n")).toContain("Postgres");
    expect(expanded.join("\n")).toContain(OTHER_OPTION);
  });
});
