"""Repository-managed builtin skill discovery and loading helpers."""

from pathlib import Path

from pydantic_ai_skills import Skill, SkillsDirectory, SkillsToolset

EXPECTED_BUILTIN_SKILL_NAMES = {
    "dispatch-triage",
    "handover-brief-builder",
    "lodging-search-advisor",
    "shipper-communication-drafter",
    "web-research-analyst",
}


def repository_root() -> Path:
    """Return the repository root directory.

    Returns:
        Absolute path to the repository root.
    """
    return Path(__file__).resolve().parents[4]


def builtin_skills_path() -> Path:
    """Return the directory that stores repository-managed skills.

    Returns:
        Absolute path to the builtin skills directory.
    """
    return repository_root() / "skills"


def builtin_skills_directory(
    validate: bool = True, max_depth: int | None = 3
) -> SkillsDirectory:
    """Build a skills directory loader for builtin repository skills.

    Args:
        validate: Whether to validate discovered skills while loading them.
        max_depth: Maximum directory depth to traverse while discovering skills.

    Returns:
        Configured skills directory loader rooted at the builtin skills path.
    """
    return SkillsDirectory(
        path=builtin_skills_path(), validate=validate, max_depth=max_depth
    )


def load_builtin_skills(
    validate: bool = True, max_depth: int | None = 3
) -> dict[str, Skill]:
    """Load builtin skills and index them by skill name.

    Args:
        validate: Whether to validate discovered skills while loading them.
        max_depth: Maximum directory depth to traverse while discovering skills.

    Returns:
        Mapping of skill names to loaded skill definitions.
    """
    directory = builtin_skills_directory(validate=validate, max_depth=max_depth)
    return {skill.name: skill for skill in directory.skills.values()}


def build_builtin_skills_toolset(
    validate: bool = True,
    max_depth: int | None = 3,
    exclude_tools: set[str] | list[str] | None = None,
) -> SkillsToolset:
    """Build a toolset exposing builtin repository skills.

    Args:
        validate: Whether to validate discovered skills while loading them.
        max_depth: Maximum directory depth to traverse while discovering skills.
        exclude_tools: Optional tool names to exclude from the exported toolset.

    Returns:
        Skills toolset configured to serve builtin repository skills.
    """
    return SkillsToolset(
        directories=[builtin_skills_directory(validate=validate, max_depth=max_depth)],
        exclude_tools=exclude_tools,
    )
