import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function frontmatter(file: string): Record<string, string> {
  const block = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").flatMap((line) => {
      const match = line.match(/^([a-z-]+):\s*(.+)$/);
      return match ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

describe("package resources", () => {
  test("every skill and prompt declared in `pi` exists", () => {
    for (const entry of [...manifest.pi.skills, ...manifest.pi.prompts]) {
      expect(statSync(join(root, entry)).isDirectory()).toBe(true);
    }
  });

  test("every skill directory has a portable SKILL.md", () => {
    for (const dir of manifest.pi.skills) {
      for (const name of readdirSync(join(root, dir))) {
        const meta = frontmatter(join(root, dir, name, "SKILL.md"));
        // Portable skills are named after their directory.
        expect(meta.name).toBe(name);
        expect((meta.description ?? "").length).toBeGreaterThan(20);
      }
    }
  });

  test("every prompt is a Markdown file with a description", () => {
    for (const dir of manifest.pi.prompts) {
      for (const file of readdirSync(join(root, dir))) {
        expect(frontmatter(join(root, dir, file)).description).toBeTruthy();
      }
    }
  });

  test("the packaged files include every declared resource root", () => {
    for (const entry of [...manifest.pi.skills, ...manifest.pi.prompts]) {
      const segment = entry.replace(/^\.\//, "").split("/")[0];
      expect(manifest.files).toContain(segment);
    }
  });
});
