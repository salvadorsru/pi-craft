import { describe, expect, test } from "bun:test";
import { checkReadOnlyCommand, isReadOnlySegment } from "../src/shell.ts";

const safe = (command: string) =>
	expect(checkReadOnlyCommand(command, "Ask mode").safe, command).toBe(true);
const blocked = (command: string) =>
	expect(checkReadOnlyCommand(command, "Ask mode").safe, command).toBe(false);

describe("checkReadOnlyCommand: reading", () => {
	test("allows file reading and searching", () => {
		safe("cat src/main.rs");
		safe("head -n 20 Cargo.toml");
		safe("grep -rn 'fn main' src");
		safe("rg --files-with-matches ReadOnly src");
		safe("find src -name '*.rs'");
		safe("ls -la /mnt/data/Proyectos");
		safe("wc -l src/lib.rs");
		safe("jq '.dependencies' package.json");
		safe("sort Cargo.lock | uniq");
	});

	test("allows read-only git and cargo", () => {
		safe("git status --short");
		safe("git log --oneline -20");
		safe("git diff --stat HEAD");
		safe("git show HEAD:src/lib.rs");
		safe("cargo tree --depth 1");
		safe("cargo metadata --no-deps");
	});

	test("allows assignments and env that stay read-only", () => {
		safe("FOO=bar grep -r FOO src");
		safe("env FOO=bar ls src");
	});
});

describe("checkReadOnlyCommand: writing", () => {
	test("blocks file changes", () => {
		blocked("rm -rf target");
		blocked("mv a b");
		blocked("cp a b");
		blocked("mkdir build");
		blocked("touch new.txt");
		blocked("tee out.txt");
		blocked("cat a > b");
		blocked("echo hi >> log");
	});

	test("blocks chaining and substitution", () => {
		blocked("ls; rm -rf target");
		blocked("ls && rm -rf target");
		blocked("ls || true");
		blocked("echo $(cat secret)");
		blocked("echo `id`");
	});

	test("blocks commands that hide a write in a flag", () => {
		blocked("find . -delete");
		blocked("find . -exec rm {} +");
		blocked("sort -o Cargo.lock Cargo.lock");
		blocked("rg --pre 'sh -c rm' pattern");
		blocked("fd -x rm");
		blocked("tree -o listing.txt");
		blocked("date -s '2020-01-01'");
		blocked("hostname newname");
	});

	test("blocks git that runs an external program", () => {
		blocked("git -c core.pager=less log");
		blocked("git diff --ext-diff");
		blocked("git commit -m x");
		blocked("git push");
		blocked("git branch -D old");
		blocked("git remote add origin https://example.com/x.git");
	});

	test("blocks an assignment that names a command", () => {
		blocked("GIT_EXTERNAL_DIFF=sh git diff");
		blocked("PATH=/tmp ls");
		blocked("PAGER=/tmp/x git log");
	});

	test("blocks interpreters and package managers", () => {
		blocked("python3 -c 'open(\"x\",\"w\")'");
		blocked("node -e \"require('fs').writeFileSync('x','')\"");
		blocked("npm install");
		blocked("cargo build");
		blocked("bun add left-pad");
		blocked("sudo ls");
		blocked("vim src/main.rs");
	});

	test("blocks a path that only pretends to be a read-only tool", () => {
		blocked("./scripts/ls");
		blocked("/tmp/ls");
		blocked("./tools/grep -r x");
	});

	test("blocked reasons name the mode", () => {
		const check = checkReadOnlyCommand("rm -rf target", "Ask mode");
		expect(check.safe).toBe(false);
		expect(check.reason).toContain("Ask mode");
	});
});

describe("isReadOnlySegment", () => {
	test("checks one pipe segment at a time", () => {
		expect(isReadOnlySegment("grep -rn x src")).toBe(true);
		expect(isReadOnlySegment("rm -rf src")).toBe(false);
		expect(isReadOnlySegment("git status")).toBe(true);
		expect(isReadOnlySegment("git add .")).toBe(false);
	});
});
