import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  description: string;
  path: string;
  skillName: string;
  skipReferences: boolean;
  skipScripts: boolean;
};

const defaultDescription = "[TODO: Explain what the skill does and when it should trigger.]";

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const skillName = normalizeSkillName(options.skillName);
  const skillDirectory = resolve(options.path, skillName);

  mkdirSync(skillDirectory, { recursive: false });
  writeFileSync(
    resolve(skillDirectory, "SKILL.md"),
    renderSkillMarkdown(skillName, options.description),
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  if (!options.skipScripts) {
    mkdirSync(resolve(skillDirectory, "scripts"), { recursive: true });
  }
  if (!options.skipReferences) {
    mkdirSync(resolve(skillDirectory, "references"), { recursive: true });
  }

  console.log(`created ${skillDirectory}`);
  console.log(`- ${resolve(skillDirectory, "SKILL.md")}`);
  if (!options.skipScripts) {
    console.log(`- ${resolve(skillDirectory, "scripts")}`);
  }
  if (!options.skipReferences) {
    console.log(`- ${resolve(skillDirectory, "references")}`);
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    description: defaultDescription,
    path: defaultSkillsRoot(),
    skillName: "",
    skipReferences: false,
    skipScripts: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--description") {
      options.description = readOptionValue(args, index);
      index += 1;
      continue;
    }
    if (arg === "--path") {
      options.path = resolve(readOptionValue(args, index));
      index += 1;
      continue;
    }
    if (arg === "--skip-references") {
      options.skipReferences = true;
      continue;
    }
    if (arg === "--skip-scripts") {
      options.skipScripts = true;
      continue;
    }
    if (arg?.startsWith("--") === true) {
      usage(`Unknown option: ${arg}`);
    }
    if (options.skillName !== "") {
      usage("Only one skill name may be provided.");
    }
    options.skillName = arg ?? "";
  }

  if (options.skillName.trim() === "") {
    usage("Missing skill name.");
  }
  return options;
}

function readOptionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage(`Missing value for ${args[index]}.`);
  }
  return value;
}

function normalizeSkillName(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .toLocaleLowerCase();
  if (normalized === "") {
    throw new Error("skill name must contain at least one letter or digit");
  }
  return normalized;
}

function renderSkillMarkdown(skillName: string, description: string): string {
  return [
    "---",
    `name: ${skillName}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${displayName(skillName)}`,
    "",
    "State the core workflow in imperative form.",
    "Keep this file short and move detailed supporting material into `references/` or `scripts/`.",
    "",
  ].join("\n");
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function displayName(skillName: string): string {
  return skillName
    .split("-")
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function defaultSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../");
}

function usage(message: string): never {
  console.error(message);
  console.error(
    "Usage: tsx scripts/init_codex_skill.ts <skill-name> [--path <dir>] [--description <text>] [--skip-scripts] [--skip-references]",
  );
  process.exit(1);
}

main();
