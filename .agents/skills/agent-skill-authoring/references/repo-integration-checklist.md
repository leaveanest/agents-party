# Repository Integration Checklist

Use this checklist before treating a Codex skill as a standard repository workflow.

## Before Adding The Skill

- Confirm the workflow is expected to recur in this repository.
- Confirm the skill adds reusable guidance, references, or scripts that a normal prompt would not.
- Confirm the skill name and description are specific enough to avoid accidental triggering.

## When The Skill Is Added

- Place the folder under `.agents/skills/`.
- Keep the folder self-contained with `SKILL.md` and only the needed resource directories.
- Avoid coupling the skill to temporary files outside the repository.

## Validation

- Run `scripts/validate_codex_skill.py <skill-folder-or-name>`.
- Run repository checks on any changed Python modules that support the skill.
- Make sure no unrelated files were introduced into the skill folder.
