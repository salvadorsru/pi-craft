import { describe, expect, test } from "bun:test";
import craftExtension from "../extensions/craft/index.ts";
import type { StepResult, StepRunner } from "../src/plan/agents.ts";
import { OTHER_OPTION } from "../src/plan/question.ts";

type Handler = (...args: any[]) => any;

let strikeCalls = 0;

/** Subagent that finishes its batch at once, with the markers it was given. */
const instant: StepRunner = async (prompt) => ({
  text: [...prompt.matchAll(/\[DONE:\d+\]/g)].map((match) => match[0]).join(" "),
  files: [],
  stopReason: "stop",
  usedTools: true,
});

/** Subagent whose runs finish only when the test resolves or aborts them. */
function pending() {
  const resolvers: Array<(result: StepResult) => void> = [];  const prompts: string[] = [];
  const run: StepRunner = (prompt, signal) =>
    new Promise((resolve) => {
      prompts.push(prompt);
      const settle = (result: StepResult) => {
        const index = resolvers.indexOf(settle);
        if (index !== -1) resolvers.splice(index, 1);
        resolve(result);
      };
      resolvers.push(settle);
      signal?.addEventListener(
        "abort",
        () => settle({ text: "", files: [], stopReason: "aborted", usedTools: true }),
        { once: true },
      );
    });
  return {
    run,
    prompts,
    resolve(
      result: StepResult = { text: "", files: [], stopReason: "stop", usedTools: true },
    ) {
      resolvers.shift()?.(result);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
  strikethrough: (text: string) => {
    strikeCalls++;
    return `~~${text}~~`;
  },
};

function makeHarness(
  options: {
    branch?: any[];
    choice?: string | null;
    input?: string;
    confirm?: boolean;
    run?: StepRunner;
  } = {},
) {
  strikeCalls = 0;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const messageRenderers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const selectCalls: { title: string; options: string[] }[] = [];
  const sent: any[] = [];
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, any> = {};
  const entries: any[] = [];
  let activeTools: string[] = ["read", "bash", "edit", "write"];

  const pi: any = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerFlag() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerShortcut() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType: string, renderer: Handler) {
      messageRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
    },
    getFlag() {
      return false;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
    getActiveTools() {
      return activeTools;
    },
    sendMessage(message: any, sendOptions: any) {
      sent.push({ message, options: sendOptions });
    },
    sendUserMessage(message: string) {
      sent.push({ message, user: true });
    },
  };

  const ctx: any = {
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getBranch: () => options.branch ?? [],
    },
    ui: {
      theme,
      setStatus(key: string, text: string | undefined) {
        statuses[key] = text;
      },
      setWidget(key: string, content: any) {
        widgets[key] = content;
      },
      notify() {},
      select: async (title: string, choices: string[]) => {
        selectCalls.push({ title, options: choices });
        if (options.choice === null) return undefined;
        return options.choice ?? "Execute the plan";
      },
      input: async () => options.input,
      confirm: async () => options.confirm ?? false,
      editor: async () => undefined,
    },
  };

  const emit = async (event: string, ...args: any[]) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(...args);
    }
  };

  /** Render the current widget the way pi would: factory → component → lines. */
  const widgetLines_ = (key: string, width = 80): string[] | undefined => {
    const factory = widgets[key];
    if (factory === undefined) return undefined;
    if (Array.isArray(factory)) return factory;
    return factory({}, theme).render(width);
  };

  const renderMessage = (
    customType: string,
    message: any,
    renderOptions: { expanded?: boolean; outputPad?: number } = {},
  ): string[] => {
    const renderer = messageRenderers.get(customType);
    if (!renderer) throw new Error(`no renderer for ${customType}`);
    const component = renderer(
      message,
      { expanded: renderOptions.expanded ?? false, outputPad: renderOptions.outputPad ?? 1 },
      theme,
    );
    return component.render(80);
  };

  craftExtension(pi, { run: options.run ?? instant });

  return {
    activeTools: () => activeTools,
    commands,
    ctx,
    emit,
    entries,
    handlers,
    messageRenderers,
    renderMessage,
    selectCalls,
    sent,
    statuses,
    strikethroughCalls: () => strikeCalls,
    tools,
    widgets,
    widgetLines: widgetLines_,
  };
}

const planText = `Plan:
1. Fix the parser in src/planner.ts.
2. Keep the full step text.`;

const fiveStepsText = `Plan:
1. First step.
2. Second step.
3. Third step.
4. Fourth step.
5. Fifth step.`;

describe("plan extension", () => {
  test("sends the first batch and drops the plan-mode context", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    const exec = h.sent.find((item) => item.message?.customType === "pi-plan-execute");
    expect(exec).toBeDefined();
    expect(exec.message.content).toContain("Remaining steps:");
    expect(exec.message.content).toContain("1. Fix the parser in src/planner.ts.");
    expect(exec.message.content).toContain("Work on these steps only, in order:");
    expect(exec.message.content).toContain("steps 1-2 of 2");
    expect(exec.message.content).toContain("[DONE:1] [DONE:2]");
    expect(exec.options).toEqual({ triggerTurn: false });
    expect(exec.message.details.steps).toHaveLength(2);

    const contextHandler = h.handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();
    const filtered = await contextHandler!(
      {
        messages: [
          { role: "custom", customType: "pi-plan-context", content: "old plan context" },
          { role: "user", content: "hello" },
        ],
      },
      h.ctx,
    );
    const kept = filtered.messages.map((m: any) => m.customType ?? m.role);
    expect(kept).toEqual(["user"]);
  });

  test("shows the extracted plan as a checklist before executing", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    const planCard = h.sent.find(
      (item) => item.message?.customType === "pi-plan-todo-list",
    );
    expect(planCard).toBeDefined();
    const lines = h.renderMessage("pi-plan-todo-list", planCard.message);
    const text = lines.join("\n");
    expect(text).toContain("Plan");
    expect(text).toContain("2 steps");
    expect(text).toContain("[ ]");
    expect(text).toContain("Fix the parser in src/planner.ts.");
  });

  test("ticks the batch from [DONE:n] even when the subagent ran no tools", async () => {
    const h = makeHarness({
      run: async () => ({
        text: "Done with both. [DONE:1] [DONE:2]",
        files: [],
        stopReason: "stop",
        usedTools: false,
      }),
    });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.steps.every((step: any) => step.completed)).toBe(
      true,
    );
    expect(h.widgets["pi-plan-todos"]).toBeUndefined();
    expect(h.statuses["pi-plan"]).toBeUndefined();

    const card = h.renderMessage("pi-plan-complete", complete.message).join("\n");
    expect(card).toContain("Plan complete");
    expect(card).toContain("2/2 steps");
    expect(card).toContain("[x]");
    expect(card).toContain("Fix the parser in src/planner.ts.");
    expect(card).toContain("Keep the full step text.");
    expect(card).not.toContain("~~");
    expect(complete.message.content).toContain("- [x] 1.");
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("completes a whole batch in one subagent run without markers", async () => {
    const h = makeHarness({
      run: async () => ({
        text: "Parser fixed.",
        files: ["src/planner.ts"],
        stopReason: "stop",
        usedTools: true,
      }),
    });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    const runs = h.sent.filter(
      (item) => item.message?.customType === "pi-plan-execute",
    );
    expect(runs).toHaveLength(1);

    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.files).toEqual(["src/planner.ts"]);
    expect(complete.message.details.steps.every((step: any) => step.completed)).toBe(
      true,
    );
    expect(h.statuses["pi-plan"]).toBeUndefined();
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("leaves the batch open when the subagent was aborted or did no work", async () => {
    const results: StepResult[] = [
      { text: "", files: [], stopReason: "aborted", usedTools: true },
      {
        text: "Which file should I start with?",
        files: [],
        stopReason: "stop",
        usedTools: false,
      },
    ];
    const h = makeHarness({ run: async () => results.shift()! });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    expect(h.statuses["pi-plan"]).toContain("0/2");

    // A run that only replied (no tool call, no marker) is not progress either.
    await h.commands.get("plan:retry").handler("", h.ctx);
    expect(h.statuses["pi-plan"]).toContain("0/2");
    expect(
      h.sent.filter((item) => item.message?.customType === "pi-plan-execute"),
    ).toHaveLength(2);
  });

  test("summarises the files touched while executing", async () => {
    const h = makeHarness({
      run: async () => ({
        text: "[DONE:1] [DONE:2]",
        files: ["src/planner.ts", "tests/planner.test.ts", "src/planner.ts"],
        stopReason: "stop",
        usedTools: true,
      }),
    });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete.message.details.files).toEqual([
      "src/planner.ts",
      "tests/planner.test.ts",
    ]);

    const collapsed = h
      .renderMessage("pi-plan-complete", complete.message)
      .join("\n");
    expect(collapsed).toContain("2 files changed");
    // The paths stay in the expanded view; the collapsed one only counts them.
    expect(collapsed).not.toContain("tests/planner.test.ts");

    const expanded = h
      .renderMessage("pi-plan-complete", complete.message, { expanded: true })
      .join("\n");
    expect(expanded).toContain("src/planner.ts");
    expect(expanded).toContain("tests/planner.test.ts");
  });

  test("restores execute state and progress on resume", async () => {
    const h = makeHarness({
      branch: [
        {
          type: "custom",
          customType: "pi-plan",
          data: {
            mode: "execute",
            steps: [
              { step: 1, text: "First real step", completed: true },
              { step: 2, text: "Second real step", completed: false },
            ],
          },
        },
      ],
    });

    await h.emit("session_start", {}, h.ctx);

    // Resuming does not start a subagent on its own: the checklist is restored
    // from the persisted entry and /plan:retry continues from the open step.
    expect(h.sent).toHaveLength(0);
    expect(h.statuses["pi-plan"]).toContain("1/2");
    const lines = h.widgetLines("pi-plan-todos") ?? [];
    expect(lines.join("\n")).toContain("First real step");
    expect(lines[1]).toContain("[x]");
    expect(lines[2]).toContain("[>]");
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("closes a resumed plan whose steps are already done", async () => {
    const h = makeHarness({
      branch: [
        {
          type: "custom",
          customType: "pi-plan",
          data: {
            mode: "execute",
            steps: [{ step: 1, text: "Only step", completed: true }],
            startedAt: Date.now() - 5_000,
          },
        },
      ],
    });

    await h.emit("session_start", {}, h.ctx);

    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.steps[0].completed).toBe(true);
    expect(h.statuses["pi-plan"]).toBeUndefined();
    expect(h.widgets["pi-plan-todos"]).toBeUndefined();
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("activates ask_question and points the model at it while planning", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);

    expect(h.activeTools()).toContain("ask_question");
    expect(h.tools.get("ask_question")).toBeDefined();

    const result = await h.handlers.get("before_agent_start")![0]();
    expect(result.message.content).toContain("ask_question");
  });

  test("ask_question returns the option the user selects", async () => {
    const h = makeHarness({ choice: "Postgres" });
    const tool = h.tools.get("ask_question");

    const result = await tool.execute(
      "call-1",
      {
        question: "Which database should the plan use?",
        options: ["Postgres", "SQLite"],
      },
      undefined,
      undefined,
      h.ctx,
    );

    expect(h.selectCalls).toHaveLength(1);
    expect(h.selectCalls[0].title).toBe("Which database should the plan use?");
    // The escape hatch is always offered next to the suggestions.
    expect(h.selectCalls[0].options).toEqual([
      "Postgres",
      "SQLite",
      OTHER_OPTION,
    ]);
    expect(result.details).toEqual({
      question: "Which database should the plan use?",
      answer: "Postgres",
      cancelled: false,
    });
    expect(result.content[0].text).toContain("The user answered:");
    expect(result.content[0].text).toContain("Postgres");
  });

  test("ask_question accepts a custom answer through the Other option", async () => {
    const h = makeHarness({ choice: OTHER_OPTION, input: "  MySQL  " });

    const result = await h.tools.get("ask_question").execute(
      "call-2",
      {
        question: "Which database?",
        options: ["Postgres", "SQLite"],
      },
      undefined,
      undefined,
      h.ctx,
    );

    expect(result.details.answer).toBe("MySQL");
    expect(result.details.cancelled).toBe(false);
  });

  test("asks for free text when no options are suggested", async () => {
    const h = makeHarness({ input: "Keep the current API" });

    const result = await h.tools.get("ask_question").execute(
      "call-3",
      { question: "How should the migration behave?" },
      undefined,
      undefined,
      h.ctx,
    );

    expect(h.selectCalls).toHaveLength(0);
    expect(result.details.answer).toBe("Keep the current API");
  });

  test("ask_question reports a dismissal instead of inventing an answer", async () => {
    const h = makeHarness({ choice: null });

    const result = await h.tools.get("ask_question").execute(
      "call-4",
      { question: "Which database?", options: ["Postgres"] },
      undefined,
      undefined,
      h.ctx,
    );

    expect(result.details).toEqual({
      question: "Which database?",
      cancelled: true,
    });
    expect(result.content[0].text).toContain("dismissed");
    expect(result.content[0].text).toContain("Do not assume an answer");
  });

  test("ask_question falls back to plain text when there is no UI", async () => {
    const h = makeHarness();
    h.ctx.hasUI = false;

    const result = await h.tools.get("ask_question").execute(
      "call-5",
      { question: "Which database?" },
      undefined,
      undefined,
      h.ctx,
    );

    expect(h.selectCalls).toHaveLength(0);
    expect(result.details.unavailable).toBe(true);
    expect(result.content[0].text).toContain("plain text");
  });

  test("does not open the execute dialog when the model asked a question", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);

    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Which package manager does this project use?" },
            ],
          },
        ],
      },
      h.ctx,
    );

    // The user answers in the editor; no "Execute / Stay / Refine" dialog.
    expect(h.selectCalls).toHaveLength(0);
    expect(
      h.sent.filter((item) => item.message?.customType === "pi-plan-todo-list"),
    ).toHaveLength(0);
    expect(h.statuses["pi-plan"]).toContain("plan");
  });

  test("/plan:skip drops the step in flight and starts the rest", async () => {
    const four = `Plan:
1. First step.
2. Second step.
3. Third step.
4. Fourth step.`;
    const child = pending();
    const h = makeHarness({ run: child.run });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: four }] }] },
      h.ctx,
    );
    await flush();

    expect(child.prompts[0]).toContain("steps 1-3 of 4");

    await h.commands.get("plan:skip").handler("", h.ctx);
    await flush();

    // The skipped step is done and the next batch already started.
    expect(h.statuses["pi-plan"]).toContain("1/4");
    expect(child.prompts[1]).toContain("steps 2-4 of 4");

    child.resolve();
    await executing;
    expect(h.statuses["pi-plan"]).toBeUndefined();
  });

  test("stopping while a batch is in flight leaves every step open", async () => {
    const child = pending();
    const h = makeHarness({ run: child.run });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    await flush();

    await h.commands.get("plan:stop").handler("", h.ctx);
    await executing;

    expect(h.statuses["pi-plan"]).toBeUndefined();
    const last = h.entries.filter((entry) => entry.customType === "pi-plan").at(-1);
    expect(last.data.steps.every((step: any) => !step.completed)).toBe(true);
  });

  test("/plan:stop aborts the subagent in flight and keeps the plan", async () => {
    const child = pending();
    const h = makeHarness({ run: child.run });
    const notes: string[] = [];
    h.ctx.ui.notify = (text: string) => notes.push(text);
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    await flush();
    expect(h.statuses["pi-plan"]).toContain("0/2");

    await h.commands.get("plan:stop").handler("", h.ctx);
    await executing;

    // Execute is full access, so the mode is gone by its badge, not its tools.
    expect(h.statuses["pi-plan"]).toBeUndefined();
    expect(notes[notes.length - 1]).toContain("Plan stopped at step 1");

    notes.length = 0;
    await h.commands.get("plan:status").handler("", h.ctx);
    expect(notes[0]).toContain("Fix the parser in src/planner.ts");
  });

  test("/plan:retry runs the open step again from normal", async () => {
    const results: StepResult[] = [
      { text: "", files: [], stopReason: "aborted", usedTools: true },
      {
        text: "[DONE:1] [DONE:2]",
        files: [],
        stopReason: "stop",
        usedTools: false,
      },
    ];
    const h = makeHarness({ run: async () => results.shift()! });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    await h.commands.get("plan:stop").handler("", h.ctx);

    expect(h.statuses["pi-plan"]).toBeUndefined();

    await h.commands.get("plan:retry").handler("", h.ctx);

    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.steps.every((step: any) => step.completed)).toBe(
      true,
    );
    expect(h.statuses["pi-plan"]).toBeUndefined();
  });

  test("/plan off and on set the mode instead of toggling blindly", async () => {
    const h = makeHarness();
    const notes: string[] = [];
    h.ctx.ui.notify = (text: string) => notes.push(text);
    await h.emit("session_start", {}, h.ctx);

    await h.commands.get("plan").handler("off", h.ctx);
    expect(notes[notes.length - 1]).toBe("Plan mode is off.");
    expect(h.activeTools()).toContain("edit");

    await h.commands.get("plan").handler("on", h.ctx);
    expect(notes[notes.length - 1]).toContain("Plan mode enabled");
    expect(h.activeTools()).not.toContain("edit");

    await h.commands.get("plan").handler("on", h.ctx);
    expect(notes[notes.length - 1]).toBe("Plan mode is already on.");
    expect(h.activeTools()).not.toContain("edit");

    await h.commands.get("plan").handler("off", h.ctx);
    expect(h.activeTools()).toContain("edit");
  });

  test("runs three steps per subagent and marks them together", async () => {
    const child = pending();
    const h = makeHarness({ run: child.run });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: fiveStepsText }] }] },
      h.ctx,
    );
    await flush();

    expect(child.prompts[0]).toContain("steps 1-3 of 5");

    child.resolve();
    await flush();

    // The first batch is marked as a block and the next one follows.
    expect(h.statuses["pi-plan"]).toContain("3/5");
    expect(child.prompts[1]).toContain("steps 4-5 of 5");

    child.resolve();
    await executing;
    expect(h.statuses["pi-plan"]).toBeUndefined();
  });

  test("runs batches in plan order and never overlaps them", async () => {
    const child = pending();
    const h = makeHarness({ run: child.run });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: fiveStepsText }] }] },
      h.ctx,
    );
    await flush();

    // Nothing starts while the previous batch is still running.
    expect(child.prompts).toHaveLength(1);
    expect(child.prompts[0]).toContain("1. First step.");

    child.resolve();
    await flush();

    expect(child.prompts).toHaveLength(2);
    expect(child.prompts[1]).toContain("4. Fourth step.");
    expect(child.prompts[1]).not.toContain("3. Third step.");

    const persisted = h.entries
      .filter((entry) => entry.customType === "pi-plan")
      .at(-1);
    expect(persisted.data.steps.slice(0, 3).every((step: any) => step.completed)).toBe(
      true,
    );
    expect(persisted.data.steps[3].completed).toBe(false);

    child.resolve();
    await executing;
  });

  test("a subagent that fails leaves its batch open", async () => {
    const failing: StepResult[] = [
      { text: "", files: [], stopReason: "error", usedTools: true },
    ];
    const h = makeHarness({ run: async () => failing.shift()! });
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    expect(h.statuses["pi-plan"]).toContain("0/2");

    // A runner that throws is reported instead of ticking anything.
    const notes: { text: string; type?: string }[] = [];
    const broken = makeHarness({
      run: async () => {
        throw new Error("no model");
      },
    });
    broken.ctx.ui.notify = (text: string, type?: string) =>
      notes.push({ text, type });
    await broken.emit("session_start", {}, broken.ctx);
    await broken.commands.get("plan").handler("", broken.ctx);
    await broken.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      broken.ctx,
    );

    expect(notes.at(-1)?.type).toBe("error");
    expect(notes.at(-1)?.text).toContain("Subagent failed");
    expect(broken.statuses["pi-plan"]).toContain("0/2");
  });

  test("/plan:batch sets how many steps one subagent runs", async () => {
    const child = pending();
    const h = makeHarness({ run: child.run });
    const notes: string[] = [];
    h.ctx.ui.notify = (text: string) => notes.push(text);
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);

    await h.commands.get("plan:batch").handler("2", h.ctx);
    expect(notes.at(-1)).toContain("up to 2 steps");
    const persisted = h.entries
      .filter((entry) => entry.customType === "pi-plan")
      .at(-1);
    expect(persisted.data.batch).toBe(2);

    await h.commands.get("plan:batch").handler("", h.ctx);
    expect(notes.at(-1)).toContain("up to 2 steps");

    const executing = h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: fiveStepsText }] }] },
      h.ctx,
    );
    await flush();
    expect(child.prompts[0]).toContain("steps 1-2 of 5");

    child.resolve();
    await flush();
    expect(child.prompts[1]).toContain("steps 3-4 of 5");

    child.resolve();
    await flush();
    expect(child.prompts[2]).toContain("step 5 of 5");

    child.resolve();
    await executing;
    expect(h.statuses["pi-plan"]).toBeUndefined();
  });
});
