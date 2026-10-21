/**
 * Ask Mode Extension
 *
 * A read-only question-and-answer mode: the model reads the project to answer
 * questions but cannot change it.
 *
 * The mode state, the active tool set, the read-only guard and persistence are
 * owned by the shared mode runtime. That is what makes `/ask` and
 * `/plan`
 * mutually exclusive: entering one leaves the other.
 *
 * Features:
 * - /ask toggles the mode; /ask on|off|status; /ask <question> asks right away
 * - Ctrl+Alt+A toggles it, --ask starts in it
 * - edit/write are disabled and bash is restricted to read-only commands
 * - Footer status while active; state survives session resume
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeRegistry } from "../modes/index.js";

/** The read-only tools ask mode keeps. */
const ASK_MODE_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** `customType` of the hidden instruction message. */
const ASK_CONTEXT_TYPE = "ask-mode-context";

/** Marker used to drop the instructions from old turns once the mode is off. */
const ASK_MARKER = "[ASK MODE ACTIVE]";

const ASK_PROMPT = `${ASK_MARKER}
You are in ask mode: you answer questions about this project, you do not change it.

Restrictions:
- edit, write and powershell are disabled.
- bash only runs read-only commands (reading, searching, git status/log/diff).
- Describe a change instead of making one; the user can leave ask mode to apply it.

How to answer:
- Read the relevant code before answering, and cite file:line.
- Answer what was asked; do not rewrite files or propose that you already changed them.
- If the question needs a change, show the exact edit as a suggestion.`;

export function registerAsk(pi: ExtensionAPI, modes: ModeRegistry): void {
	modes.define({
		id: "ask",
		label: "Ask mode",
		readOnly: true,
		tools: ASK_MODE_TOOLS,
		flag: "ask",
		marker: ASK_MARKER,
		contextType: ASK_CONTEXT_TYPE,
		prompt: ASK_PROMPT,
	});

	// Sessions created before this version stored `{ enabled, toolsBeforeAsk }`.
	modes.registerLegacy("ask-mode", (data) => {
		return (data as { enabled?: boolean } | undefined)?.enabled ? "ask" : undefined;
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"ask-mode",
			modes.is("ask") ? ctx.ui.theme.fg("success", "ask") : undefined,
		);
	}

	modes.onChange((_to, _from, ctx) => updateStatus(ctx));

	function notify(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) ctx.ui.notify(text, "info");
	}

	function setAskMode(ctx: ExtensionContext, enabled: boolean): void {
		if (enabled) {
			if (modes.enter("ask", ctx)) {
				notify(ctx, "Ask mode on: read-only questions. edit/write are disabled and bash is read-only.");
			}
			return;
		}
		if (modes.is("ask") && modes.leave(ctx)) {
			notify(ctx, "Ask mode off: the full tool set is back.");
		}
	}

	// --- Commands -----------------------------------------------------------

	pi.registerCommand("ask", {
		description: "Toggle ask mode (read-only Q&A). Also /ask on|off|status, or /ask <question>",
		handler: async (args, ctx) => {
			const text = args.trim();
			const word = text.toLowerCase();
			if (word === "on") {
				setAskMode(ctx, true);
				return;
			}
			if (word === "off") {
				setAskMode(ctx, false);
				return;
			}
			if (word === "status") {
				notify(ctx, modes.is("ask") ? "Ask mode is on (read-only)." : "Ask mode is off.");
				return;
			}
			if (text) {
				// /ask <question>: turn the mode on and ask it.
				setAskMode(ctx, true);
				pi.sendUserMessage(text);
				return;
			}
			setAskMode(ctx, !modes.is("ask"));
		},
	});

	pi.registerShortcut("ctrl+alt+a", {
		description: "Toggle ask mode",
		handler: async (ctx) => setAskMode(ctx, !modes.is("ask")),
	});

	pi.registerFlag("ask", {
		description: "Start in ask mode (read-only Q&A)",
		type: "boolean",
		default: false,
	});
}
