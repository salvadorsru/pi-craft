/**
 * The mode runtime.
 *
 * Pi loads every extension in its own module root, so two packages cannot rely
 * on sharing a dependency instance (see Pi's package documentation). The
 * runtime therefore lives on a `Symbol.for` slot of `globalThis`: whichever
 * copy of this package loads first creates it, and every later copy — even a
 * physically duplicated one — talks to the same object.
 *
 * The runtime is the single owner of:
 * - the current mode and its transitions,
 * - the active tool set (`pi.setActiveTools`),
 * - the read-only guard (`tool_call`),
 * - the mode prompt and its context filtering,
 * - persistence (`pi.appendEntry("pi-modes")`).
 *
 * Extensions only declare modes and react to changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkReadOnlyCommand, MUTATING_BUILTIN_TOOLS } from "./shell.js";
import type {
	ChangeListener,
	LegacyResolver,
	ModeId,
	ModeSpec,
} from "./types.js";

/** Channel emitted on `pi.events` after every transition. */
export const MODE_CHANGE_CHANNEL = "pi-modes:change";

/** `customType` of the persisted mode entry. */
export const MODE_ENTRY_TYPE = "pi-modes";

/** `globalThis` slot shared by every copy of this package. */
const GLOBAL_KEY = Symbol.for("@salvadorsru/pi-modes/registry/v1");

interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	openWorldHint?: boolean;
}

interface ToolInfoLike {
	name: string;
	annotations?: ToolAnnotations;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface BeforeAgentStartLike {
	messageType?: "user" | "custom";
}

interface ContextEventLike {
	messages: unknown[];
}

interface ToolCallEventLike {
	toolName: string;
	input?: Record<string, unknown>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			(block as { type?: string; text?: string })?.type === "text"
				? ((block as { text?: string }).text ?? "")
				: "",
		)
		.join("\n");
}

function isModeSpec(value: unknown): value is ModeSpec {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ModeSpec).id === "string" &&
		(value as ModeSpec).id.length > 0
	);
}

export class ModeRegistry {
	private readonly specs = new Map<ModeId, ModeSpec>();
	private readonly listeners = new Set<ChangeListener>();
	private readonly legacyResolvers = new Map<string, LegacyResolver>();
	private api: ExtensionAPI | undefined;
	private currentMode: ModeId | undefined;
	private baseline: string[] | undefined;
	private installed = false;

	// --- Registration -------------------------------------------------------

	/** Bind to a Pi API and install the runtime handlers exactly once. */
	install(api: ExtensionAPI): this {
		this.api = api;
		if (this.installed) return this;
		this.installed = true;

		api.on("session_start", ((_event: unknown, ctx: ExtensionContext) => {
			this.restore(ctx);
		}) as never);

		api.on("before_agent_start", ((event: BeforeAgentStartLike, ctx: ExtensionContext) => {
			return this.prompt(event, ctx);
		}) as never);

		api.on("context", ((event: ContextEventLike) => {
			return this.filterContext(event);
		}) as never);

		api.on("tool_call", ((event: ToolCallEventLike) => {
			return this.guard(event);
		}) as never);

		return this;
	}

	/** Declare a mode. Must run during extension load, before `session_start`. */
	define(spec: ModeSpec): this {
		if (!isModeSpec(spec)) throw new Error("pi-modes: a mode needs a non-empty id");
		if (this.specs.has(spec.id)) throw new Error(`pi-modes: mode "${spec.id}" is already defined`);
		this.specs.set(spec.id, { ...spec });
		return this;
	}

	/** Teach the runtime how to read this extension's pre-migration entries. */
	registerLegacy(customType: string, resolve: LegacyResolver): this {
		this.legacyResolvers.set(customType, resolve);
		return this;
	}

	/** Subscribe to transitions. Returns the unsubscribe function. */
	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// --- Queries ------------------------------------------------------------

	/** Current mode id, or `undefined` for normal. */
	current(): ModeId | undefined {
		return this.currentMode;
	}

	/** Human name of the current mode, or `normal`. */
	label(): string {
		const spec = this.spec();
		return spec?.label ?? spec?.id ?? "normal";
	}

	is(id: ModeId): boolean {
		return this.currentMode === id;
	}

	spec(id: ModeId | undefined = this.currentMode): ModeSpec | undefined {
		return id === undefined ? undefined : this.specs.get(id);
	}

	readOnly(): boolean {
		return this.spec()?.readOnly === true;
	}

	modeIds(): ModeId[] {
		return [...this.specs.keys()];
	}

	// --- Transitions --------------------------------------------------------

	/** Enter a mode. Returns whether the state changed. */
	enter(id: ModeId, ctx: ExtensionContext): boolean {
		const spec = this.specs.get(id);
		if (!spec) throw new Error(`pi-modes: unknown mode "${id}"`);
		const from = this.currentMode;
		if (from === id) return false;
		this.captureBaseline();
		if (from) this.specs.get(from)?.onLeave?.(ctx, id);
		this.currentMode = id;
		spec.onEnter?.(ctx, from);
		this.applyTools();
		this.persist();
		this.emit(id, from, ctx);
		return true;
	}

	/** Return to normal. Returns whether the state changed. */
	leave(ctx: ExtensionContext): boolean {
		const from = this.currentMode;
		if (!from) return false;
		this.specs.get(from)?.onLeave?.(ctx, undefined);
		this.currentMode = undefined;
		this.applyTools();
		this.persist();
		this.emit(undefined, from, ctx);
		return true;
	}

	/** Enter `id` if another mode is current, leave if `id` is already current. */
	toggle(id: ModeId, ctx: ExtensionContext): "entered" | "left" | "unchanged" {
		if (this.is(id)) return this.leave(ctx) ? "left" : "unchanged";
		return this.enter(id, ctx) ? "entered" : "unchanged";
	}

	// --- Internals ----------------------------------------------------------

	private emit(to: ModeId | undefined, from: ModeId | undefined, ctx: ExtensionContext): void {
		for (const listener of [...this.listeners]) listener(to, from, ctx);
		try {
			this.api?.events?.emit(MODE_CHANGE_CHANNEL, {
				mode: to ?? "normal",
				previous: from ?? "normal",
			});
		} catch {
			// An event consumer must never break a transition.
		}
	}

	private persist(): void {
		try {
			this.api?.appendEntry(MODE_ENTRY_TYPE, { mode: this.currentMode ?? null });
		} catch {
			// Persistence is best-effort; a session without storage still works.
		}
	}

	private applyTools(): void {
		if (!this.api) return;
		const spec = this.spec();
		const tools = spec?.tools ?? this.baseline;
		if (!tools) return;
		try {
			this.api.setActiveTools([...new Set(tools)]);
		} catch {
			// Tools may not be registered yet during early startup.
		}
	}

	private captureBaseline(): void {
		if (this.baseline !== undefined) return;
		try {
			this.baseline = this.api?.getActiveTools() ?? [];
		} catch {
			this.baseline = [];
		}
	}

	private restore(ctx: ExtensionContext): void {
		this.captureBaseline();

		let next: ModeId | undefined;
		let fromSharedEntry = false;
		const branch = this.branchOf(ctx);

		// The shared entry is authoritative when present.
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
			fromSharedEntry = true;
			const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
			next = typeof mode === "string" && this.specs.has(mode) ? mode : undefined;
		}

		if (!fromSharedEntry) {
			// Pre-migration sessions: ask and plan each wrote their own entry.
			// The last one wins, which is deterministic and fixes the old
			// "both read-only guards are on" state.
			let foundLegacy = false;
			for (const entry of branch) {
				if (entry.type !== "custom" || !entry.customType) continue;
				const resolve = this.legacyResolvers.get(entry.customType);
				if (!resolve) continue;
				foundLegacy = true;
				next = resolve(entry.data);
			}

			if (!foundLegacy) {
				for (const spec of this.specs.values()) {
					if (!spec.flag) continue;
					try {
						if (this.api?.getFlag(spec.flag) === true) {
							next = spec.id;
							break;
						}
					} catch {
						// Unknown flags are ignored.
					}
				}
			}
		}

		this.currentMode = next;
		this.applyTools();
		this.emit(next, undefined, ctx);

		// Starting from a flag is a real transition worth persisting.
		if (next !== undefined && !fromSharedEntry) this.persist();
	}

	private branchOf(ctx: ExtensionContext): SessionEntryLike[] {
		try {
			return (ctx.sessionManager.getBranch() ?? []) as SessionEntryLike[];
		} catch {
			return [];
		}
	}

	private prompt(event: BeforeAgentStartLike | undefined, ctx: ExtensionContext) {
		const spec = this.spec();
		if (!spec?.prompt) return undefined;
		// Runs started by custom messages already carry the context they need.
		if (event?.messageType !== undefined && event.messageType !== "user") return undefined;
		const content =
			typeof spec.prompt === "function" ? spec.prompt(ctx) : spec.prompt;
		if (!content) return undefined;
		return {
			message: {
				customType: spec.contextType ?? `pi-mode-${spec.id}`,
				display: false,
				content,
			},
		};
	}

	private filterContext(event: ContextEventLike | undefined) {
		const messages = event?.messages;
		if (!Array.isArray(messages)) return undefined;

		const active = this.spec();
		const contextTypes = new Map<ModeId, string>();
		for (const spec of this.specs.values()) {
			contextTypes.set(spec.id, spec.contextType ?? `pi-mode-${spec.id}`);
		}
		const activeType = active ? contextTypes.get(active.id) : undefined;

		let newestActive = -1;
		if (active?.keepNewestContext) {
			messages.forEach((message, index) => {
				if ((message as { customType?: string })?.customType === activeType) {
					newestActive = index;
				}
			});
		}

		const inactiveMarkers = [...this.specs.values()]
			.filter((spec) => spec.marker && spec.marker !== active?.marker)
			.map((spec) => spec.marker as string);

		return {
			messages: messages.filter((message, index) => {
				const entry = message as { customType?: string; role?: string; content?: unknown };
				const customType = entry?.customType;
				if (typeof customType === "string") {
					const owner = [...contextTypes.entries()].find(([, type]) => type === customType);
					if (owner) {
						if (!active || owner[0] !== active.id) return false;
						if (active.keepNewestContext) return index === newestActive;
						return true;
					}
				}

				if (entry?.role !== "user") return true;
				const text = textOf(entry.content);
				return !inactiveMarkers.some((marker) => text.includes(marker));
			}),
		};
	}

	private guard(event: ToolCallEventLike | undefined) {
		if (!event?.toolName || !this.readOnly()) return undefined;
		const label = this.spec()?.label ?? "Read-only mode";

		if (MUTATING_BUILTIN_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `${label} is on: file modifications are blocked.`,
			};
		}

		if (event.toolName === "bash") {
			const command = event.input?.command;
			const check = checkReadOnlyCommand(typeof command === "string" ? command : "", label);
			if (!check.safe) return { block: true, reason: check.reason };
			return undefined;
		}

		const annotations = this.annotationsOf(event.toolName);
		if (
			annotations &&
			annotations.readOnlyHint !== true &&
			(annotations.destructiveHint === true || annotations.openWorldHint === true)
		) {
			return {
				block: true,
				reason: `${label} is on: ${event.toolName} can change something outside this conversation.`,
			};
		}

		return undefined;
	}

	private annotationsOf(toolName: string): ToolAnnotations | undefined {
		try {
			const tools = this.api?.getAllTools?.() as ToolInfoLike[] | undefined;
			return tools?.find((tool) => tool.name === toolName)?.annotations;
		} catch {
			return undefined;
		}
	}
}

/**
 * Get the process-wide runtime and bind it to `pi`.
 *
 * The first call installs the handlers; later calls only bind and let the
 * caller declare more modes.
 */
export function getModes(pi?: ExtensionAPI): ModeRegistry {
	const slot = globalThis as unknown as Record<symbol, ModeRegistry | undefined>;
	let registry = slot[GLOBAL_KEY];
	if (!registry) {
		registry = new ModeRegistry();
		slot[GLOBAL_KEY] = registry;
	}
	if (pi) registry.install(pi);
	return registry;
}

/** Drop the process-wide runtime. Intended for tests. */
export function resetModes(): void {
	const slot = globalThis as unknown as Record<symbol, ModeRegistry | undefined>;
	delete slot[GLOBAL_KEY];
}
