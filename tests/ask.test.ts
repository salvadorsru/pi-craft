import { describe, expect, test } from "bun:test";
import { createCraft } from "../extensions/craft/index.ts";

type Handler = (...args: any[]) => any;

const theme = { fg: (_color: string, text: string) => text };

function makeHarness(options: { branch?: any[]; flags?: Record<string, boolean> } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const notes: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const entries: any[] = [];
	const sent: string[] = [];
	let activeTools = ["read", "bash", "edit", "write"];

	const pi: any = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerFlag() {},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerShortcut() {},
		registerTool() {},
		registerMessageRenderer() {},
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
			return [];
		},
		sendUserMessage(message: string) {
			sent.push(message);
		},
		sendMessage() {},
		events: { emit() {}, on() { return () => {}; } },
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
			setStatus(key: string, text: string | undefined) {
				statuses[key] = text;
			},
			setWidget() {},
			select: async () => undefined,
			editor: async () => undefined,
		},
	};

	const emit = async (event: string, ...args: any[]) => {
		for (const handler of handlers.get(event) ?? []) await handler(...args);
	};

	const runGuard = async (event: any) => {
		let result: any;
		for (const handler of handlers.get("tool_call") ?? []) {
			const next = await handler(event);
			if (next !== undefined) result = next;
		}
		return result;
	};

	const modes = createCraft(pi);

	return {
		activeTools: () => activeTools,
		commands,
		ctx,
		emit,
		entries,
		modes,
		notes,
		runGuard,
		sent,
		statuses,
	};
}

describe("ask extension", () => {
	test("turns ask mode on and off with the tool set and the badge", async () => {
		const h = makeHarness();
		await h.emit("session_start", {}, h.ctx);

		await h.commands.get("ask").handler("on", h.ctx);
		expect(h.activeTools()).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(h.statuses["ask-mode"]).toBe("ask");
		expect(h.entries.at(-1)).toEqual({ customType: "pi-craft", data: { mode: "ask" } });

		await h.commands.get("ask").handler("off", h.ctx);
		expect(h.activeTools()).toEqual(["read", "bash", "edit", "write"]);
		expect(h.statuses["ask-mode"]).toBeUndefined();
	});

	test("another mode turns ask off automatically", async () => {
		const h = makeHarness();
		await h.emit("session_start", {}, h.ctx);
		await h.commands.get("ask").handler("on", h.ctx);

		// The plan mode defined by the same extension.
		h.modes.enter("plan", h.ctx);

		expect(h.modes.is("ask")).toBe(false);
		expect(h.statuses["ask-mode"]).toBeUndefined();
		expect(h.activeTools()).toEqual(["read", "bash", "grep", "find", "ls", "ask_question"]);
	});

	test("blocks mutating tools through the shared guard", async () => {
		const h = makeHarness();
		await h.emit("session_start", {}, h.ctx);
		await h.commands.get("ask").handler("on", h.ctx);

		expect(await h.runGuard({ toolName: "edit", input: {} })).toMatchObject({ block: true });
		expect(await h.runGuard({ toolName: "write", input: {} })).toMatchObject({ block: true });
		expect(
			await h.runGuard({ toolName: "bash", input: { command: "rm -rf src" } }),
		).toMatchObject({ block: true });
		expect(
			await h.runGuard({ toolName: "bash", input: { command: "git status" } }),
		).toBeUndefined();

		await h.commands.get("ask").handler("off", h.ctx);
		expect(await h.runGuard({ toolName: "edit", input: {} })).toBeUndefined();
	});

	test("restores ask mode from a legacy session entry", async () => {
		const h = makeHarness({
			branch: [{ type: "custom", customType: "ask-mode", data: { enabled: true } }],
		});
		await h.emit("session_start", {}, h.ctx);

		expect(h.modes.is("ask")).toBe(true);
		expect(h.statuses["ask-mode"]).toBe("ask");
		expect(h.activeTools()).not.toContain("edit");
	});

	test("starts ask mode from the --ask flag", async () => {
		const h = makeHarness({ flags: { ask: true } });
		await h.emit("session_start", {}, h.ctx);
		expect(h.modes.is("ask")).toBe(true);
	});

	test("/ask <question> turns the mode on and sends the prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start", {}, h.ctx);
		await h.commands.get("ask").handler("What does src/index.ts do?", h.ctx);
		expect(h.modes.is("ask")).toBe(true);
		expect(h.sent).toEqual(["What does src/index.ts do?"]);
	});
});
