import { describe, expect, test } from "bun:test";
import { createModes } from "../src/modes/registry.ts";

type Handler = (...args: any[]) => any;

const theme = { fg: (_color: string, text: string) => text };

function makeHarness(options: { branch?: any[]; flags?: Record<string, boolean> } = {}) {
	const handlers = new Map<string, Handler[]>();
	const entries: { customType: string; data: any }[] = [];
	const busEvents: { channel: string; data: any }[] = [];
	const notes: string[] = [];
	let activeTools = ["read", "bash", "edit", "write"];

	const pi: any = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		onChange() {},
		registerFlag() {},
		registerCommand() {},
		registerShortcut() {},
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
		getFlag(name: string) {
			return options.flags?.[name] ?? false;
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(tools: string[]) {
			activeTools = [...tools];
		},
		getAllTools() {
			return [
				{
					name: "write_remote",
					annotations: { readOnlyHint: false, destructiveHint: true },
				},
				{
					name: "search_remote",
					annotations: { readOnlyHint: true },
				},
			];
		},
		events: {
			emit(channel: string, data: any) {
				busEvents.push({ channel, data });
			},
			on() {
				return () => {};
			},
		},
	};

	const ctx: any = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			theme,
			notify(text: string) {
				notes.push(text);
			},
			setStatus() {},
			setWidget() {},
		},
	};

	const emit = async (event: string, ...args: any[]) => {
		for (const handler of handlers.get(event) ?? []) {
			await handler(...args);
		}
	};

	const modes = createModes(pi);
	modes.define({
		id: "ask",
		label: "Ask mode",
		readOnly: true,
		tools: ["read", "grep", "find", "ls", "bash"],
		flag: "ask",
		marker: "[ASK MODE ACTIVE]",
		contextType: "ask-mode-context",
		prompt: "[ASK MODE ACTIVE]\nAsk only.",
	});
	modes.define({
		id: "plan",
		label: "Plan mode",
		readOnly: true,
		tools: ["read", "grep", "find", "ls", "bash"],
		marker: "[PLAN MODE ACTIVE]",
		contextType: "pi-plan-context",
		prompt: "[PLAN MODE ACTIVE]\nPlan only.",
		keepNewestContext: true,
	});
	modes.define({ id: "execute", label: "Plan execution" });
	modes.registerLegacy("ask-mode", (data: any) => (data?.enabled ? "ask" : undefined));
	modes.registerLegacy("pi-plan", (data: any) =>
		data?.mode === "plan" ? "plan" : data?.mode === "execute" ? "execute" : undefined,
	);

	return {
		activeTools: () => activeTools,
		busEvents,
		ctx,
		emit,
		entries,
		modes,
		notes,
		pi,
	};
}

describe("mode runtime", () => {
	test("entering and leaving a mode owns the active tools", () => {
		const h = makeHarness();

		expect(h.modes.enter("ask", h.ctx)).toBe(true);
		expect(h.activeTools()).toEqual(["read", "grep", "find", "ls", "bash"]);

		expect(h.modes.leave(h.ctx)).toBe(true);
		expect(h.activeTools()).toEqual(["read", "bash", "edit", "write"]);
		expect(h.modes.current()).toBeUndefined();
	});

	test("modes are exclusive: entering plan turns ask off", () => {
		const h = makeHarness();
		const changes: string[] = [];
		h.modes.onChange((to, from) => changes.push(`${from ?? "normal"}>${to ?? "normal"}`));

		h.modes.enter("ask", h.ctx);
		h.modes.enter("plan", h.ctx);

		expect(h.modes.current()).toBe("plan");
		expect(changes).toEqual(["normal>ask", "ask>plan"]);
		expect(h.activeTools()).not.toContain("edit");
	});

	test("does not restore a stale snapshot when another mode changed the tools", () => {
		const h = makeHarness();

		// Ask is entered while plan already restricts the set: the baseline,
		// not the plan-era set, must come back.
		h.modes.enter("plan", h.ctx);
		h.modes.enter("ask", h.ctx);
		h.modes.leave(h.ctx);
		expect(h.activeTools()).toEqual(["read", "bash", "edit", "write"]);

		h.modes.enter("execute", h.ctx);
		expect(h.activeTools()).toEqual(["read", "bash", "edit", "write"]);
	});

	test("persists the shared mode entry and emits the event bus channel", () => {
		const h = makeHarness();

		h.modes.enter("ask", h.ctx);
		expect(h.entries.at(-1)).toEqual({ customType: "pi-craft", data: { mode: "ask" } });

		h.modes.leave(h.ctx);
		expect(h.entries.at(-1)).toEqual({ customType: "pi-craft", data: { mode: null } });
		expect(h.busEvents.map((event) => event.data.mode)).toEqual(["ask", "normal"]);
	});

	test("restores the shared entry on session start", async () => {
		const h = makeHarness({
			branch: [{ type: "custom", customType: "pi-craft", data: { mode: "plan" } }],
		});
		await h.emit("session_start", {}, h.ctx);

		expect(h.modes.current()).toBe("plan");
		expect(h.activeTools()).not.toContain("edit");
	});

	test("legacy entries: the last one wins and shared entries beat them", async () => {
		const legacy = makeHarness({
			branch: [
				{ type: "custom", customType: "ask-mode", data: { enabled: true } },
				{ type: "custom", customType: "pi-plan", data: { mode: "execute" } },
			],
		});
		await legacy.emit("session_start", {}, legacy.ctx);
		expect(legacy.modes.current()).toBe("execute");

		const shared = makeHarness({
			branch: [
				{ type: "custom", customType: "ask-mode", data: { enabled: true } },
				{ type: "custom", customType: "pi-craft", data: { mode: "plan" } },
				{ type: "custom", customType: "pi-plan", data: { mode: "execute" } },
			],
		});
		await shared.emit("session_start", {}, shared.ctx);
		expect(shared.modes.current()).toBe("plan");
	});

	test("the flag starts a mode when no session state exists", async () => {
		const h = makeHarness({ flags: { ask: true } });
		await h.emit("session_start", {}, h.ctx);
		expect(h.modes.current()).toBe("ask");
		expect(h.entries.at(-1)?.data).toEqual({ mode: "ask" });
	});

	test("guard and context: uses the registered handlers", async () => {
		const h = makeHarness();
		const guardHandlers: Handler[] = [];
		const contextHandlers: Handler[] = [];
		const beforeHandlers: Handler[] = [];
		const pi = {
			...h.pi,
			on(event: string, handler: Handler) {
				if (event === "tool_call") guardHandlers.push(handler);
				if (event === "context") contextHandlers.push(handler);
				if (event === "before_agent_start") beforeHandlers.push(handler);
				return () => {};
			},
		};

		const modes = createModes(pi);
		modes.define({
			id: "ask",
			label: "Ask mode",
			readOnly: true,
			tools: ["read", "bash"],
			marker: "[ASK MODE ACTIVE]",
			contextType: "ask-mode-context",
			prompt: "[ASK MODE ACTIVE]\nAsk only.",
		});

		const ctx = { ...h.ctx };
		modes.enter("ask", ctx);

		expect(await guardHandlers[0]({ toolName: "edit", input: {} })).toMatchObject({
			block: true,
		});
		expect(await guardHandlers[0]({ toolName: "bash", input: { command: "ls" } })).toBeUndefined();
		expect(
			await guardHandlers[0]({ toolName: "bash", input: { command: "rm -rf src" } }),
		).toMatchObject({ block: true });
		expect(
			await guardHandlers[0]({ toolName: "write_remote", input: {} }),
		).toMatchObject({ block: true });
		expect(
			await guardHandlers[0]({ toolName: "search_remote", input: {} }),
		).toBeUndefined();

		const injected = await beforeHandlers[0]({ messageType: "user" }, ctx);
		expect(injected.message.customType).toBe("ask-mode-context");
		expect(injected.message.content).toContain("[ASK MODE ACTIVE]");
		expect(await beforeHandlers[0]({ messageType: "custom" }, ctx)).toBeUndefined();

		const filteredActive = await contextHandlers[0](
			{
				messages: [
					{ role: "custom", customType: "ask-mode-context", content: "x" },
					{ role: "user", content: "[ASK MODE ACTIVE] old" },
					{ role: "user", content: "hello" },
				],
			},
			ctx,
		);
		// Active mode: its own instruction and marked message stay in context.
		expect(filteredActive.messages).toHaveLength(3);

		modes.leave(ctx);
		const filteredOff = await contextHandlers[0](
			{
				messages: [
					{ role: "custom", customType: "ask-mode-context", content: "x" },
					{ role: "user", content: "[ASK MODE ACTIVE] old" },
					{ role: "user", content: "hello" },
				],
			},
			ctx,
		);
		expect(filteredOff.messages).toEqual([{ role: "user", content: "hello" }]);

		expect(await guardHandlers[0]({ toolName: "edit", input: {} })).toBeUndefined();
	});

	test("plan context keeps only the newest instruction message", async () => {
		const h = makeHarness();
		const contextHandlers: Handler[] = [];
		const pi = {
			...h.pi,
			on(event: string, handler: Handler) {
				if (event === "context") contextHandlers.push(handler);
				return () => {};
			},
		};

		const modes = createModes(pi);
		modes.define({
			id: "plan",
			readOnly: true,
			tools: ["read"],
			marker: "[PLAN MODE ACTIVE]",
			contextType: "pi-plan-context",
			keepNewestContext: true,
		});
		modes.enter("plan", h.ctx);

		const filtered = await contextHandlers[0]({
			messages: [
				{ role: "custom", customType: "pi-plan-context", content: "old" },
				{ role: "user", content: "hello" },
				{ role: "custom", customType: "pi-plan-context", content: "new" },
			],
		});
		expect(filtered.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "custom", customType: "pi-plan-context", content: "new" },
		]);
	});
});
