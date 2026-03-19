from pathlib import Path

from pydantic_ai_skills import Skill, SkillsDirectory, SkillsToolset

EXPECTED_BUILTIN_SKILL_NAMES = {
    "dispatch-triage",
    "handover-brief-builder",
    "shipper-communication-drafter",
}


def repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def builtin_skills_path() -> Path:
    return repository_root() / "skills"


def builtin_skills_directory(
    validate: bool = True, max_depth: int | None = 3
) -> SkillsDirectory:
    return SkillsDirectory(
        path=builtin_skills_path(), validate=validate, max_depth=max_depth
    )


def load_builtin_skills(
    validate: bool = True, max_depth: int | None = 3
) -> dict[str, Skill]:
    directory = builtin_skills_directory(validate=validate, max_depth=max_depth)
    return {skill.name: skill for skill in directory.skills.values()}


def build_builtin_skills_toolset(
    validate: bool = True,
    max_depth: int | None = 3,
    exclude_tools: set[str] | list[str] | None = None,
) -> SkillsToolset:
    return SkillsToolset(
        directories=[builtin_skills_directory(validate=validate, max_depth=max_depth)],
        exclude_tools=exclude_tools,
    )
