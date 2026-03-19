# Skill Best Practices

Use these rules when adding or editing Codex skills in this repository.

## Naming

- Use lowercase letters, numbers, and hyphens only.
- Keep the folder name equal to the `name` field in `SKILL.md`.
- Keep the name short and action-oriented.

## Trigger Description

- Put trigger guidance in the YAML `description`.
- State both what the skill does and the situations that should trigger it.
- Avoid vague descriptions that would match unrelated work.

## Progressive Disclosure

- Keep `SKILL.md` focused on workflow and guardrails.
- Move long examples, schemas, or reference material into `references/`.
- Add scripts for deterministic or repeated tasks that would otherwise require retyping code.

## Resource Selection

- Keep only the directories the skill uses.
- Put reusable documentation in `references/`.
- Put executable helpers in `scripts/`.
- Put templates or copied output material in `assets/` when needed.

## Validation

- Make sure `SKILL.md` has valid YAML frontmatter with `name` and `description`.
- Keep the body comfortably under the 500-line recommendation.
- Forward-test realistic tasks after major edits.
