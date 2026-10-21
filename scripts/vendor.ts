/**
 * Copy the runtime into the packages that consume it.
 *
 * pi loads every package in its own module root, and the consumers are
 * distributed independently (git or a local path). Vendoring keeps
 * `pi install git:...` working with no npm registry and no install step.
 *
 * The copies still share one registry: `getModes()` stores it on a
 * `Symbol.for` slot of `globalThis`, so a duplicated module is not a
 * duplicated mode.
 *
 * Usage:
 *   bun run scripts/vendor.ts          # write the copies
 *   bun run scripts/vendor.ts --check  # fail if a copy is stale
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SOURCE = path.join(ROOT, "src");
const FILES = ["index.ts", "registry.ts", "shell.ts", "types.ts"];

const CONSUMERS = [
	path.join(ROOT, "..", "pi-ask"),
	path.join(ROOT, "..", "pi-plan"),
];

const HEADER = (file: string) => `// GENERATED FILE — do not edit.
// Source: https://github.com/salvadorsru/pi-modes/blob/main/src/${file}
// Refresh it with \`bun run vendor\` in the pi-modes repository.
`;

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	let stale = 0;

	for (const consumer of CONSUMERS) {
		if (!existsSync(consumer)) {
			console.warn(`skip ${consumer}: not found`);
			continue;
		}

		const target = path.join(consumer, "vendor", "pi-modes");
		if (!check) await mkdir(target, { recursive: true });

		for (const file of FILES) {
			const source = await readFile(path.join(SOURCE, file), "utf8");
			const content = HEADER(file) + source;
			const destination = path.join(target, file);

			if (check) {
				const current = existsSync(destination)
					? await readFile(destination, "utf8")
					: "";
				if (current !== content) {
					console.error(`stale: ${destination}`);
					stale++;
				}
				continue;
			}

			await writeFile(destination, content, "utf8");
			console.log(`wrote ${destination}`);
		}
	}

	if (check && stale > 0) process.exit(1);
}

await main();
