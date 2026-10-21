/**
 * Mode state, tool ownership and read-only policy for pi-craft.
 *
 * See README.md for the contract.
 */

export {
	ModeRegistry,
	createModes,
	MODE_CHANGE_CHANNEL,
	MODE_ENTRY_TYPE,
} from "./registry.js";

export {
	MUTATING_BUILTIN_TOOLS,
	checkReadOnlyCommand,
	isReadOnlySegment,
	type ReadOnlyCheck,
} from "./shell.js";

export type {
	ChangeListener,
	LegacyResolver,
	ModeId,
	ModeSpec,
} from "./types.js";
