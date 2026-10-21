import { describe, expect, test } from "bun:test";
import craftExtension from "../extensions/craft/index.ts";
import { OTHER_OPTION } from "../src/plan/question.ts";

type Handler = (...args: any[]) => any;

let strikeCalls = 0;

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

  craftExtension(pi);

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

describe("plan extension", () => {
  test("sends the first step and drops the plan-mode context", async () => {
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
    expect(exec.message.content).toContain("Work on step 1 only:");
    expect(exec.message.content).toContain("[DONE:1]");
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

  test("checks a step as soon as [DONE:n] is written and completes the plan", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    // The widget now highlights the step being worked on.
    expect(h.widgetLines("pi-plan-todos")?.join("\n")).toContain("[>]");

    await h.emit(
      "message_update",
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done with the first. [DONE:1]" }],
        },
      },
      h.ctx,
    );

    expect(h.statuses["pi-plan"]).toContain("1/2");
    const afterFirst = h.widgetLines("pi-plan-todos") ?? [];
    expect(afterFirst[0]).toContain("1/2");
    expect(afterFirst[1]).toContain("[success]");
    expect(afterFirst[1]).toContain("[x]");
    // The next step is the one in progress.
    expect(afterFirst[2]).toContain("[>]");

    await h.emit(
      "message_update",
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done with the second. [DONE:2]" }],
        },
      },
      h.ctx,
    );
    expect(h.statuses["pi-plan"]).toContain("2/2");

    await h.emit("agent_end", { messages: [] }, h.ctx);
    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.steps.every((step: any) => step.completed)).toBe(
      true,
    );
    expect(h.widgets["pi-plan-todos"]).toBeUndefined();

    // The final card repeats the whole list, with ticks and a summary.
    const card = h.renderMessage("pi-plan-complete", complete.message).join("\n");
    expect(card).toContain("Plan complete");
    expect(card).toContain("2/2 steps");
    expect(card).toContain("[x]");
    expect(card).toContain("Fix the parser in src/planner.ts.");
    expect(card).toContain("Keep the full step text.");

    // Strikethrough is gone from every surface.
    expect(card).not.toContain("~~");
    expect(complete.message.content).not.toContain("~~");
    expect(complete.message.content).toContain("- [x] 1.");
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("advances one step per run even when the model emits no [DONE] tags", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    // First run: the model works with tools but never writes [DONE:n].
    await h.emit("agent_start", {});
    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "src/planner.ts" },
    });
    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Parser fixed." }],
          },
        ],
      },
      h.ctx,
    );

    // The widget ticked the first step and the next run is already queued.
    expect(h.statuses["pi-plan"]).toContain("1/2");
    const afterFirst = h.widgetLines("pi-plan-todos") ?? [];
    expect(afterFirst[1]).toContain("[x]");
    expect(afterFirst[2]).toContain("[>]");

    const execMessages = h.sent.filter(
      (item) => item.message?.customType === "pi-plan-execute",
    );
    expect(execMessages).toHaveLength(2);
    expect(execMessages[1].message.content).toContain("Work on step 2 only:");
    expect(execMessages[1].message.content).not.toContain("Work on step 1 only:");
    expect(execMessages[1].options).toEqual({ triggerTurn: true });
    expect(execMessages[1].message.details.steps[0].completed).toBe(true);

    // Second run completes the plan.
    await h.emit("agent_start", {});
    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "src/planner.ts" },
    });
    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Text kept whole." }],
          },
        ],
      },
      h.ctx,
    );

    expect(h.statuses["pi-plan"]).toBeUndefined();
    expect(h.widgets["pi-plan-todos"]).toBeUndefined();
    const complete = h.sent.find(
      (item) => item.message?.customType === "pi-plan-complete",
    );
    expect(complete).toBeDefined();
    expect(complete.message.details.files).toEqual(["src/planner.ts"]);
    expect(h.strikethroughCalls()).toBe(0);
  });

  test("does not advance a step when the run was aborted or did no work", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    // Aborted after using a tool: the step stays open.
    await h.emit("agent_start", {});
    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "src/planner.ts" },
    });
    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      h.ctx,
    );
    expect(h.statuses["pi-plan"]).toContain("0/2");

    // A run that only replied (no tool call, no marker) is not progress either.
    await h.emit("agent_start", {});
    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Which file should I start with?" }],
          },
        ],
      },
      h.ctx,
    );
    expect(h.statuses["pi-plan"]).toContain("0/2");
    expect(
      h.sent.filter((item) => item.message?.customType === "pi-plan-execute"),
    ).toHaveLength(1);
  });

  test("summarises the files touched while executing", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "src/planner.ts" },
    });
    await h.emit("tool_call", {
      toolName: "write",
      input: { path: "tests/planner.test.ts" },
    });
    // The same file twice is still one file.
    await h.emit("tool_call", {
      toolName: "edit",
      input: { path: "src/planner.ts" },
    });
    // Not a file mutation: not counted.
    await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } });

    await h.emit(
      "message_update",
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "[DONE:1] [DONE:2]" }],
        },
      },
      h.ctx,
    );
    await h.emit("agent_end", { messages: [] }, h.ctx);

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
              { step: 1, text: "First real step", completed: false },
              { step: 2, text: "Second real step", completed: false },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "First done. [DONE:1]" }],
          },
        },
      ],
    });

    await h.emit("session_start", {}, h.ctx);

    // Resuming does not start a turn on its own: the checklist is restored
    // and the next user message continues from the first pending step.
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
            steps: [{ step: 1, text: "Only step", completed: false }],
            startedAt: Date.now() - 5_000,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[DONE:1]" }],
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

  test("a question asked while executing does not tick the current step", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    await h.emit("agent_start", {});
    await h.emit("tool_call", {
      toolName: "ask_question",
      input: { question: "Refactor or patch?" },
    });
    await h.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Waiting for your answer." }],
          },
        ],
      },
      h.ctx,
    );

    // Step 1 stays open and no new execute run was queued.
    expect(h.statuses["pi-plan"]).toContain("0/2");
    expect(
      h.sent.filter((item) => item.message?.customType === "pi-plan-execute"),
    ).toHaveLength(1);
  });

  test("/plan:skip completes the current step and sends the next one", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );

    await h.commands.get("plan:skip").handler("", h.ctx);

    const runs = h.sent.filter(
      (item) => item.message?.customType === "pi-plan-execute",
    );
    expect(runs).toHaveLength(2);
    const last = runs[1].message;
    expect(last.content).toContain("Work on step 2 only:");
    expect(last.details.steps[0].completed).toBe(true);
    expect(last.details.steps[1].completed).toBe(false);
  });

  test("/plan:stop leaves the execution and keeps the plan for /plan:status", async () => {
    const h = makeHarness();
    const notes: string[] = [];
    h.ctx.ui.notify = (text: string) => notes.push(text);
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    expect(h.statuses["pi-plan"]).toContain("0/2");

    await h.commands.get("plan:stop").handler("", h.ctx);

    // Execute is full access, so the mode is gone by its badge, not its tools.
    expect(h.statuses["pi-plan"]).toBeUndefined();
    expect(notes[notes.length - 1]).toContain("Plan stopped at step 1");

    notes.length = 0;
    await h.commands.get("plan:status").handler("", h.ctx);
    expect(notes[0]).toContain("Fix the parser in src/planner.ts");
  });

  test("/plan:retry resumes the open step from normal", async () => {
    const h = makeHarness();
    await h.emit("session_start", {}, h.ctx);
    await h.commands.get("plan").handler("", h.ctx);
    await h.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: [{ type: "text", text: planText }] }] },
      h.ctx,
    );
    await h.commands.get("plan:stop").handler("", h.ctx);

    const runs = () =>
      h.sent.filter((item) => item.message?.customType === "pi-plan-execute");
    const before = runs().length;

    await h.commands.get("plan:retry").handler("", h.ctx);

    expect(h.statuses["pi-plan"]).toContain("0/2");
    expect(runs()).toHaveLength(before + 1);
    expect(runs().at(-1).message.content).toContain("Work on step 1 only:");
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
});
