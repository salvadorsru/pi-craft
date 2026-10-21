/**
 * Read-only shell checking shared by every read-only mode.
 *
 * A read-only mode may still need `bash` for `git status`, `grep`, `cat` and
 * friends. The bash tool is the one active tool that can change the machine,
 * so a command is only allowed when every pipe segment is a known read-only
 * command and the line is free of constructs that can write or run a command.
 *
 * The check is deliberately conservative: a false positive only makes the
 * model fall back to the read/grep/find/ls tools, which is the safe direction.
 *
 * This module is pure: no pi imports, no filesystem access, no state. That is
 * what makes it safe to unit test and reusable by any extension.
 */

/** Built-in tools that change files or the machine; never active in a read-only mode. */
export const MUTATING_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"powershell",
]);

/**
 * Constructs that write, run another command, or escape the allowlist. These
 * are matched anywhere on the line, not only in the first word.
 */
const NEVER_ALLOWED: RegExp[] = [
	// Redirection and process substitution.
	/>/,
	/<\(/,
	// Chaining, backgrounding, command substitution, newlines.
	/[;&`]/,
	/\$\(/,
	/\n/,
	// Commands whose own flags write or execute.
	/\bfind\b[^\n]*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
	/\brg\b[^\n]*\s--?(pre|hostname-bin)\b/,
	/\bfd\b[^\n]*\s(-x|-X|--exec|--exec-batch)\b/,
	/\bsort\b[^\n]*\s(-o\b|--output|--compress)/,
	/\btree\b[^\n]*\s-o\b/,
	/\bdate\b[^\n]*\s(-s\b|--set)/,
	/\bhostname\s+[^-]/,
	// Git that runs an external program.
	/\bgit\b[^\n]*\s(-c|--config-env)\b/,
	/\bgit\s+(diff|log|show|grep)\b[^\n]*--(ext-diff|textconv)/,
	// Git writes that do not carry an obvious flag.
	/\bgit\s+branch\s+[^-]/,
	/\bgit\s+branch\s+-[dDmMcC]/,
	/\bgit\s+tag\s+[^-]/,
	/\bgit\s+tag\s+-[dDaA]/,
	/\bgit\s+remote\s+(add|set-url|remove|rename)/,
	/\bgit\s+symbolic-ref\s+\S+\s+\S+/,
	/\bgit\s+config\s+[^\s-]/,
	/\bgit\s+stash\s+(push|pop|drop|clear)/,
	/\bgit\s+worktree\s+(add|remove|move|prune)/,
];

/** Commands that only read. The first word of a pipe segment must be one. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	// File reading.
	"cat", "bat", "head", "tail", "nl", "tac",
	// Search and find.
	"grep", "rg", "fd", "find",
	// Directory listing.
	"ls", "eza", "tree", "pwd",
	// Text processing.
	"echo", "printf", "wc", "sort", "uniq", "diff", "jq", "cut", "tr", "column", "comm", "paste", "join",
	// File metadata.
	"file", "stat", "du", "df", "basename", "dirname", "realpath", "readlink",
	// System info.
	"which", "whereis", "type", "env", "printenv", "uname", "whoami", "id", "hostname", "date", "cal", "uptime", "ps", "free", "lsblk", "lscpu",
	// Trivial probes.
	"true", "false", "test", "[",
]);

const GIT_READ_SUBCOMMAND =
	/^git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|ls-files|ls-tree|blame|describe|shortlog|for-each-ref|name-rev|grep|cat-file|show-ref|symbolic-ref|rev-list|diff-tree|diff-index|tag\s+-l|stash\s+list|worktree\s+list|--version)\b/;

const CARGO_READ_SUBCOMMAND = /^cargo\s+(tree|metadata|pkgid|locate-project|--version)\b/;

/** Directories whose `<dir>/<command>` form is a standard, trusted install. */
const TRUSTED_BIN_DIRS = ["/bin/", "/usr/bin/", "/usr/local/bin/"];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const ANY_ASSIGNMENT = /(^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;

/**
 * Assignment names that make the very next command run something else, so the
 * read-only allowlist would no longer describe what actually runs.
 */
const DANGEROUS_ASSIGNMENT_NAMES: ReadonlySet<string> = new Set([
	"PATH", "IFS", "BASH_ENV", "ENV", "CDPATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
	"GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL",
	"LESSOPEN", "LESSCLOSE", "PERL5LIB", "PYTHONPATH", "NODE_OPTIONS",
]);

export interface ReadOnlyCheck {
	safe: boolean;
	reason?: string;
}

/** Label used when the caller does not name its mode. */
const DEFAULT_LABEL = "Read-only mode";

function blockMessage(label: string): string {
	return (
		`${label} only runs read-only shell commands, and this one can change something. ` +
		"Use the read/grep/find/ls tools, or leave the mode to run it."
	);
}

/** Strip leading `env` prefixes and `FOO=bar` assignments from a segment. */
function normalizeSegment(segment: string): string {
	let text = segment.trim();
	for (let i = 0; i < 20; i++) {
		if (text.startsWith("env ")) {
			text = text.slice(4).trim();
			continue;
		}
		const assignment = text.match(ASSIGNMENT);
		if (assignment) {
			text = text.slice(assignment[0].length);
			continue;
		}
		break;
	}
	return text;
}

function baseName(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}

function isAllowedInvocation(token: string): boolean {
	const base = baseName(token);
	if (!READ_ONLY_COMMANDS.has(base)) return false;
	// A path is only trusted inside a standard bin directory: `./scripts/ls`
	// must not pass for `ls`.
	return TRUSTED_BIN_DIRS.some((dir) => token.startsWith(dir));
}

/** Does an assignment hide a command or a path the allowlist never saw? */
function hasUnsafeAssignment(text: string): boolean {
	for (const match of text.matchAll(ANY_ASSIGNMENT)) {
		const name = match[2];
		const value = match[3];
		if (DANGEROUS_ASSIGNMENT_NAMES.has(name)) return true;
		if (value.includes("/")) return true;
	}
	return false;
}

/** Is a single pipe segment (no `|`) a read-only command? */
export function isReadOnlySegment(segment: string): boolean {
	const text = normalizeSegment(segment);
	const token = text.match(/^\S+/)?.[0];
	if (!token) return false;
	if (token.includes("/")) return isAllowedInvocation(token);
	if (token === "git") return GIT_READ_SUBCOMMAND.test(text);
	if (token === "cargo") return CARGO_READ_SUBCOMMAND.test(text);
	return READ_ONLY_COMMANDS.has(token);
}

/**
 * May this shell command run while a read-only mode is on?
 * Every pipe segment must be read-only, and the whole line must be free of
 * constructs that write or execute.
 *
 * `label` names the mode in the reason (e.g. "Ask mode"); it never changes the
 * verdict.
 */
export function checkReadOnlyCommand(
	command: string,
	label: string = DEFAULT_LABEL,
): ReadOnlyCheck {
	const text = (command ?? "").trim();
	if (!text) return { safe: false, reason: `${label}: the command is empty.` };

	const message = blockMessage(label);
	for (const pattern of NEVER_ALLOWED) {
		if (pattern.test(text)) return { safe: false, reason: `${message} Command: ${text}` };
	}

	if (hasUnsafeAssignment(text)) return { safe: false, reason: `${message} Command: ${text}` };

	for (const segment of text.split("|")) {
		if (!isReadOnlySegment(segment)) return { safe: false, reason: `${message} Command: ${text}` };
	}

	return { safe: true };
}
