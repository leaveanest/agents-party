from __future__ import annotations

import argparse
from pathlib import Path

import yaml


def _resolve_skill_path(value: str) -> Path:
    candidate = Path(value).expanduser()
    if candidate.exists():
        return candidate.resolve()
    repo_skill = Path(__file__).resolve().parents[4] / ".agents" / "skills" / value
    return repo_skill.resolve()


def _parse_frontmatter(content: str) -> dict[str, str]:
    if not content.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter")
    _, frontmatter, _ = content.split("---", 2)
    parsed = yaml.safe_load(frontmatter.strip())
    if not isinstance(parsed, dict):
        raise ValueError("frontmatter must parse to a mapping")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a repository-local Codex skill."
    )
    parser.add_argument(
        "skill_path",
        help="Path to a skill directory or a skill name under the repo root .agents/skills/.",
    )
    args = parser.parse_args()

    skill_path = _resolve_skill_path(args.skill_path)
    skill_file = skill_path / "SKILL.md"
    if not skill_file.exists():
        raise SystemExit(f"missing SKILL.md at {skill_file}")

    frontmatter = _parse_frontmatter(skill_file.read_text(encoding="utf-8"))
    name = frontmatter.get("name")
    description = frontmatter.get("description")
    if not name:
        raise SystemExit("frontmatter is missing name")
    if not description:
        raise SystemExit("frontmatter is missing description")
    if name != skill_path.name:
        raise SystemExit(
            f"skill name '{name}' does not match directory '{skill_path.name}'"
        )

    print(f"skill: {name}")
    print(f"description: {description}")
    if (skill_path / "references").is_dir():
        print("references: present")
    if (skill_path / "scripts").is_dir():
        print("scripts: present")


if __name__ == "__main__":
    main()
