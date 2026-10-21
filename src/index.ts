/**
 * @salvadorsru/pi-modes
 *
 * Shared mode state, tool ownership and read-only policy for Pi extensions.
 * See README.md for the contract.
 */

export {
	ModeRegistry,
	getModes,
	resetModes,
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
