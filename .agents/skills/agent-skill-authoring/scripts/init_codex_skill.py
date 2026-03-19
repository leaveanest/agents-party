from __future__ import annotations

import argparse
import re
from pathlib import Path


def _normalize_skill_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    normalized = re.sub(r"-{2,}", "-", normalized)
    if not normalized:
        raise ValueError("skill name must contain at least one letter or digit")
    return normalized


def _display_name(skill_name: str) -> str:
    return " ".join(part.capitalize() for part in skill_name.split("-"))


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _yaml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _render_skill_md(skill_name: str, description: str) -> str:
    return f"""---
name: {skill_name}
description: {_yaml_string(description)}
---

# {_display_name(skill_name)}

State the core workflow in imperative form.
Keep this file short and move detailed supporting material into `references/` or `scripts/`.
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a repository-local Codex skill under .agents/skills."
    )
    parser.add_argument(
        "skill_name", help="Skill name. Will be normalized to lowercase hyphen-case."
    )
    parser.add_argument(
        "--path",
        default=str(Path(__file__).resolve().parents[4] / ".agents" / "skills"),
        help="Directory that will contain the skill folder. Defaults to the repo root .agents/skills/ directory.",
    )
    parser.add_argument(
        "--description",
        default="[TODO: Explain what the skill does and when it should trigger.]",
        help="Frontmatter description for SKILL.md.",
    )
    parser.add_argument(
        "--skip-scripts",
        action="store_true",
        help="Do not create a scripts/ directory.",
    )
    parser.add_argument(
        "--skip-references",
        action="store_true",
        help="Do not create a references/ directory.",
    )
    args = parser.parse_args()

    skill_name = _normalize_skill_name(args.skill_name)
    skill_dir = Path(args.path).expanduser().resolve() / skill_name
    if skill_dir.exists():
        raise SystemExit(f"skill already exists: {skill_dir}")

    _write(skill_dir / "SKILL.md", _render_skill_md(skill_name, args.description))

    if not args.skip_scripts:
        (skill_dir / "scripts").mkdir(parents=True, exist_ok=True)
    if not args.skip_references:
        (skill_dir / "references").mkdir(parents=True, exist_ok=True)

    print(f"created {skill_dir}")
    print(f"- {skill_dir / 'SKILL.md'}")
    if not args.skip_scripts:
        print(f"- {skill_dir / 'scripts'}")
    if not args.skip_references:
        print(f"- {skill_dir / 'references'}")


if __name__ == "__main__":
    main()
