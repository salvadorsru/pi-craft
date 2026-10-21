/**
 * Public types for the mode runtime.
 *
 * A "mode" is an editor-wide state, not an extension-private flag: `/ask`,
 * `/plan` and plan execution are all modes of the same machine. Extensions
 * describe a mode; the runtime owns the state, the active tool set and the
 * persistence.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Identifier of a mode. `normal` is not a mode; it is the absence of one. */
export type ModeId = string;

/**
 * Declaration of one mode.
 *
 * Only `id` is required. Everything else lets the runtime apply the
 * read-only policy, inject the mode prompt and render the footer badge.
 */
export interface ModeSpec {
	/** Unique id, e.g. `ask`, `plan`, `execute`. */
	id: ModeId;
	/** Human name used in notifications and guard reasons. */
	label?: string;
	/** Active tools while this mode is current. Omitted means the baseline set. */
	tools?: readonly string[];
	/** Block mutating tools and unsafe bash while this mode is current. */
	readOnly?: boolean;
	/** CLI flag that starts Pi in this mode (e.g. `ask`, `plan`). */
	flag?: string;
	/** Text that identifies this mode's instruction message, e.g. `[ASK MODE ACTIVE]`. */
	marker?: string;
	/** `customType` of the hidden instruction message. Defaults to `pi-mode-<id>`. */
	contextType?: string;
	/** Hidden instructions injected before each user run. */
	prompt?: string | ((ctx: ExtensionContext) => string);
	/**
	 * Keep only the newest instruction message in the context. Plan mode uses
	 * this so an older, already-completed step list does not confuse the model.
	 */
	keepNewestContext?: boolean;
	/** Called after the mode becomes current, before tools and UI update. */
	onEnter?: (ctx: ExtensionContext, from: ModeId | undefined) => void;
	/** Called before the mode stops being current. */
	onLeave?: (ctx: ExtensionContext, to: ModeId | undefined) => void;
}

/** Maps a legacy session entry to the mode it represented. */
export type LegacyResolver = (data: unknown) => ModeId | undefined;

/** Notified after every transition, including session restore. */
export type ChangeListener = (
	to: ModeId | undefined,
	from: ModeId | undefined,
	ctx: ExtensionContext,
) => void;
