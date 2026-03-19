from agents_party.agents.skills import (
    EXPECTED_BUILTIN_SKILL_NAMES,
    build_builtin_skills_toolset,
    builtin_skills_path,
    load_builtin_skills,
)


def test_builtin_skills_path_exists() -> None:
    assert builtin_skills_path().is_dir()


def test_load_builtin_skills_discovers_expected_names() -> None:
    skills = load_builtin_skills()

    assert set(skills) == EXPECTED_BUILTIN_SKILL_NAMES


def test_builtin_skills_toolset_loads_expected_skill_names() -> None:
    toolset = build_builtin_skills_toolset()

    assert (
        set(skill.name for skill in toolset.skills.values())
        == EXPECTED_BUILTIN_SKILL_NAMES
    )
