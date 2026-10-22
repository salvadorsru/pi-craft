/**
 * pi-craft
 *
 * Ask, plan and execute are modes of one state machine, so only one of them
 * is ever active. The mode runtime owns the tool set, the read-only guard,
 * the instructions and persistence; this file only wires the three modes
 * together.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsk } from "../../src/ask/index.js";
import { createModes, type ModeRegistry } from "../../src/modes/index.js";
import type { StepRunner } from "../../src/plan/agents.js";
import { registerPlan } from "../../src/plan/index.js";

export interface CraftOptions {
	/** Runs one batch of plan steps; tests inject a fake child. */
	run?: StepRunner;
}

export function createCraft(
	pi: ExtensionAPI,
	options: CraftOptions = {},
): ModeRegistry {
	const modes = createModes(pi);

	// Sessions from the separate pi-ask/pi-plan packages (and the short-lived
	// shared `pi-modes` runtime) still restore their last mode.
	modes.registerLegacy("pi-modes", (data) => {
		const mode = (data as { mode?: unknown } | undefined)?.mode;
		return typeof mode === "string" ? mode : undefined;
	});

	registerAsk(pi, modes);
	registerPlan(pi, modes, options);

	return modes;
}

export default function craftExtension(
	pi: ExtensionAPI,
	options: CraftOptions = {},
): void {
	createCraft(pi, options);
}
