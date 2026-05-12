import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SkillFrontmatter = {
  description: string;
  name: string;
};

function main(): void {
  const skillArgument = process.argv[2];
  if (skillArgument === undefined || skillArgument.trim() === "") {
    usage("Missing skill path or name.");
  }

  const skillPath = resolveSkillPath(skillArgument);
  const skillFile = resolve(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) {
    throw new Error(`missing SKILL.md at ${skillFile}`);
  }

  const frontmatter = parseFrontmatter(readFileSync(skillFile, "utf8"));
  const directoryName = skillPath.split(/[\\/]/u).at(-1);
  if (frontmatter.name !== directoryName) {
    throw new Error(
      `skill name '${frontmatter.name}' does not match directory '${directoryName ?? ""}'`,
    );
  }

  console.log(`skill: ${frontmatter.name}`);
  console.log(`description: ${frontmatter.description}`);
  if (isDirectory(resolve(skillPath, "references"))) {
    console.log("references: present");
  }
  if (isDirectory(resolve(skillPath, "scripts"))) {
    console.log("scripts: present");
  }
}

function resolveSkillPath(value: string): string {
  const directPath = resolve(value);
  if (existsSync(directPath)) {
    return directPath;
  }
  return resolve(defaultSkillsRoot(), value);
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (match?.[1] === undefined) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const parsed = parseFlatYaml(match[1]);
  const name = parsed.name;
  const description = parsed.description;
  if (name === undefined || name.trim() === "") {
    throw new Error("frontmatter is missing name");
  }
  if (description === undefined || description.trim() === "") {
    throw new Error("frontmatter is missing description");
  }
  return { description, name };
}

function parseFlatYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    result[key] = unquoteYamlScalar(value);
  }
  return result;
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function defaultSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../");
}

function usage(message: string): never {
  console.error(message);
  console.error("Usage: tsx scripts/validate_codex_skill.ts <skill-folder-or-name>");
  process.exit(1);
}

main();
